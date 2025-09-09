


// server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import pdfParse from "pdf-parse-fixed";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const upload = multer({ dest: path.join(__dirname, '../uploads/') });

// In-memory storage for documents and chat sessions
const documentStore = new Map();
const chatSessions = new Map();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Gemini API key from .env
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ GOOGLE_GEMINI_API_KEY not found in .env file");
  process.exit(1);
}

// --- Gemini API call function ---
async function askGemini(prompt) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" +
      GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";
}

// --- Upload & process PDF ---
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Read PDF
    const pdfBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(pdfBuffer);
    const text = pdfData.text;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "Empty PDF text" });
    }

    // Generate unique document ID
    const docId = Date.now().toString();
    
    // Ask Gemini for comprehensive legal analysis
    const prompt = `
      You are an expert legal AI assistant specializing in contract and legal document analysis.
      
      Analyze the following legal document and provide a comprehensive analysis in this EXACT JSON format:
      
      {
        "summary": {
          "overview": "Complete overview of the document in 2-3 paragraphs",
          "documentType": "Type of legal document (contract, agreement, etc.)",
          "parties": "Who are the main parties involved",
          "purpose": "Main purpose and objectives of this document"
        },
        "clauses": [
          {
            "title": "Clause name/title",
            "description": "What this clause means in simple language",
            "benefits": ["List of benefits for each party"],
            "risks": ["List of potential risks or losses"],
            "importance": "High/Medium/Low"
          }
        ],
        "keyTerms": [
          {
            "term": "Legal term",
            "explanation": "Simple explanation of what this means",
            "impact": "How this affects the parties"
          }
        ],
        "riskAssessment": {
          "overallRisk": "Low/Medium/High",
          "criticalPoints": ["Most important things to watch out for"],
          "recommendations": ["Practical advice for the parties"]
        }
      }
      
      Document Text:
      ${text}
      
      IMPORTANT: Return ONLY valid JSON, no additional text or explanations.
    `;

    const aiResponse = await askGemini(prompt);

    // Parse AI response
    let analysis;
    try {
      // Clean the response - remove any markdown formatting
      let cleanResponse = aiResponse.trim();
      
      // Remove markdown code blocks with more robust regex
      cleanResponse = cleanResponse.replace(/^```json\s*\n?/, '').replace(/\n?\s*```$/, '');
      cleanResponse = cleanResponse.replace(/^```\s*\n?/, '').replace(/\n?\s*```$/, '');
      
      // Remove any leading/trailing whitespace and newlines
      cleanResponse = cleanResponse.trim();
      
      console.log('Cleaned response length:', cleanResponse.length);
      console.log('First 100 chars:', cleanResponse.substring(0, 100));
      console.log('Last 100 chars:', cleanResponse.substring(cleanResponse.length - 100));
      
      analysis = JSON.parse(cleanResponse);
      console.log('✅ Successfully parsed AI response');
    } catch (e) {
      console.error('❌ Failed to parse AI response:', e.message);
      console.log('Raw AI response length:', aiResponse.length);
      console.log('First 500 chars:', aiResponse.substring(0, 500));
      console.log('Last 500 chars:', aiResponse.substring(aiResponse.length - 500));
      
      // Try alternative parsing approach
      try {
        // Look for JSON content between ```json and ```
        const jsonMatch = aiResponse.match(/```json\s*\n([\s\S]*?)\n\s*```/);
        if (jsonMatch && jsonMatch[1]) {
          analysis = JSON.parse(jsonMatch[1].trim());
          console.log('✅ Successfully parsed AI response using alternative method');
        } else {
          throw new Error('No JSON found in markdown blocks');
        }
      } catch (e2) {
        console.error('❌ Alternative parsing also failed:', e2.message);
        
        // Create a fallback analysis structure
        analysis = {
          summary: {
            overview: aiResponse,
            documentType: "Legal Document",
            parties: "Not specified",
            purpose: "Document analysis"
          },
          clauses: [],
          keyTerms: [],
          riskAssessment: {
            overallRisk: "Unknown",
            criticalPoints: ["Unable to parse detailed analysis"],
            recommendations: ["Please review the document manually"]
          },
          rawResponse: aiResponse
        };
      }
    }

    // Store document and analysis
    documentStore.set(docId, {
      id: docId,
      originalText: text,
      analysis: analysis,
      uploadedAt: new Date().toISOString(),
      fileName: req.file.originalname
    });

    // Initialize chat session
    chatSessions.set(docId, []);

    // Cleanup uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      message: "PDF processed successfully",
      documentId: docId,
      analysis: analysis,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Processing failed", detail: err.message });
  }
});

// ===== CHAT BOT API ENDPOINTS =====

// Chat endpoint for document queries
app.post("/api/chat/:documentId", async (req, res) => {
  try {
    const { documentId } = req.params;
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    const document = documentStore.get(documentId);
    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Get chat history
    const chatHistory = chatSessions.get(documentId) || [];
    
    // Create context-aware prompt
    const chatPrompt = `
      You are a legal AI assistant helping with questions about a specific legal document.
      
      Document Analysis Summary:
      ${JSON.stringify(document.analysis, null, 2)}
      
      Original Document Text (for reference):
      ${document.originalText.substring(0, 3000)}...
      
      Previous Chat History:
      ${chatHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n')}
      
      Current Question: ${question}
      
      Please provide a practical, easy-to-understand answer based on the document analysis.
      Focus on:
      1. Direct answer to the question
      2. Relevant clauses or terms from the document
      3. Practical implications
      4. Any warnings or important considerations
      
      Keep your response conversational and helpful.
    `;

    const aiResponse = await askGemini(chatPrompt);

    // Store chat message
    const chatMessage = {
      role: "user",
      content: question,
      timestamp: new Date().toISOString()
    };
    
    const aiMessage = {
      role: "assistant", 
      content: aiResponse,
      timestamp: new Date().toISOString()
    };

    chatHistory.push(chatMessage, aiMessage);
    chatSessions.set(documentId, chatHistory);

    res.json({
      success: true,
      answer: aiResponse,
      documentId: documentId,
      chatHistory: chatHistory,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat processing failed", detail: err.message });
  }
});

// ===== DOCUMENT ANALYSIS API ENDPOINTS =====

// Get complete document analysis
app.get("/api/document/:documentId", (req, res) => {
  const { documentId } = req.params;
  const document = documentStore.get(documentId);
  
  if (!document) {
    return res.status(404).json({ error: "Document not found" });
  }

  res.json({
    success: true,
    documentId: documentId,
    fileName: document.fileName,
    uploadedAt: document.uploadedAt,
    analysis: document.analysis
  });
});

// Get only document summary
app.get("/api/document/:documentId/summary", (req, res) => {
  const { documentId } = req.params;
  const document = documentStore.get(documentId);
  
  if (!document) {
    return res.status(404).json({ error: "Document not found" });
  }

  res.json({
    success: true,
    documentId: documentId,
    summary: document.analysis.summary || null
  });
});

// Get only clauses analysis
app.get("/api/document/:documentId/clauses", (req, res) => {
  const { documentId } = req.params;
  const document = documentStore.get(documentId);
  
  if (!document) {
    return res.status(404).json({ error: "Document not found" });
  }

  res.json({
    success: true,
    documentId: documentId,
    clauses: document.analysis.clauses || []
  });
});

// Get only risk assessment
app.get("/api/document/:documentId/risks", (req, res) => {
  const { documentId } = req.params;
  const document = documentStore.get(documentId);
  
  if (!document) {
    return res.status(404).json({ error: "Document not found" });
  }

  res.json({
    success: true,
    documentId: documentId,
    riskAssessment: document.analysis.riskAssessment || null
  });
});

// Get only key terms
app.get("/api/document/:documentId/terms", (req, res) => {
  const { documentId } = req.params;
  const document = documentStore.get(documentId);
  
  if (!document) {
    return res.status(404).json({ error: "Document not found" });
  }

  res.json({
    success: true,
    documentId: documentId,
    keyTerms: document.analysis.keyTerms || []
  });
});

// Get all documents list
app.get("/api/documents", (req, res) => {
  const documents = Array.from(documentStore.values()).map(doc => ({
    id: doc.id,
    fileName: doc.fileName,
    uploadedAt: doc.uploadedAt,
    documentType: doc.analysis?.summary?.documentType || 'Unknown',
    overallRisk: doc.analysis?.riskAssessment?.overallRisk || 'Unknown'
  }));

  res.json({
    success: true,
    count: documents.length,
    documents: documents
  });
});

// Test endpoint to check parsing
app.post("/api/test-parse", (req, res) => {
  const { testResponse } = req.body;
  
  if (!testResponse) {
    return res.status(400).json({ error: "testResponse is required" });
  }
  
  try {
    // Test the same parsing logic
    let cleanResponse = testResponse.trim();
    cleanResponse = cleanResponse.replace(/^```json\s*\n?/, '').replace(/\n?\s*```$/, '');
    cleanResponse = cleanResponse.replace(/^```\s*\n?/, '').replace(/\n?\s*```$/, '');
    cleanResponse = cleanResponse.trim();
    
    const parsed = JSON.parse(cleanResponse);
    res.json({
      success: true,
      parsed: parsed,
      cleanResponse: cleanResponse.substring(0, 200) + '...'
    });
  } catch (e) {
    // Try alternative method
    try {
      const jsonMatch = testResponse.match(/```json\s*\n([\s\S]*?)\n\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        const parsed = JSON.parse(jsonMatch[1].trim());
        res.json({
          success: true,
          parsed: parsed,
          method: "alternative",
          extracted: jsonMatch[1].substring(0, 200) + '...'
        });
      } else {
        throw new Error('No JSON found in markdown blocks');
      }
    } catch (e2) {
      res.json({
        success: false,
        error: e2.message,
        rawResponse: testResponse.substring(0, 500) + '...'
      });
    }
  }
});

// Get chat history for a document
app.get("/api/chat/:documentId/history", (req, res) => {
  const { documentId } = req.params;
  const chatHistory = chatSessions.get(documentId) || [];
  
  res.json({
    success: true,
    documentId: documentId,
    chatHistory: chatHistory,
    messageCount: chatHistory.length
  });
});

// Clear chat history for a document
app.delete("/api/chat/:documentId/history", (req, res) => {
  const { documentId } = req.params;
  
  if (!documentStore.has(documentId)) {
    return res.status(404).json({ error: "Document not found" });
  }
  
  chatSessions.set(documentId, []);
  
  res.json({
    success: true,
    message: "Chat history cleared",
    documentId: documentId
  });
});

// Get all chat sessions
app.get("/api/chat/sessions", (req, res) => {
  const sessions = Array.from(chatSessions.entries()).map(([docId, history]) => ({
    documentId: docId,
    messageCount: history.length,
    lastMessage: history.length > 0 ? history[history.length - 1].timestamp : null,
    document: documentStore.has(docId) ? {
      fileName: documentStore.get(docId).fileName,
      documentType: documentStore.get(docId).analysis?.summary?.documentType
    } : null
  }));

  res.json({
    success: true,
    count: sessions.length,
    sessions: sessions
  });
});

// Legacy endpoints for backward compatibility
app.post("/chat/:documentId", async (req, res) => {
  // Redirect to new API endpoint
  req.url = req.url.replace('/chat/', '/api/chat/');
  return app._router.handle(req, res);
});

app.get("/chat/:documentId", (req, res) => {
  // Redirect to new API endpoint
  req.url = req.url.replace('/chat/', '/api/chat/') + '/history';
  return app._router.handle(req, res);
});

app.get("/", (req, res) => {
  res.send(`
    <h1>✅ Legal AI Server</h1>
    <p>Server is running! Available endpoints:</p>
    
    <h2>📄 Document Analysis API</h2>
    <ul>
      <li><strong>POST /upload</strong> - Upload PDF for analysis</li>
      <li><strong>GET /api/document/:id</strong> - Get complete document analysis</li>
      <li><strong>GET /api/document/:id/summary</strong> - Get document summary only</li>
      <li><strong>GET /api/document/:id/clauses</strong> - Get clauses analysis only</li>
      <li><strong>GET /api/document/:id/risks</strong> - Get risk assessment only</li>
      <li><strong>GET /api/document/:id/terms</strong> - Get key terms only</li>
      <li><strong>GET /api/documents</strong> - Get all documents list</li>
    </ul>
    
    <h2>💬 Chat Bot API</h2>
    <ul>
      <li><strong>POST /api/chat/:id</strong> - Ask questions about document</li>
      <li><strong>GET /api/chat/:id/history</strong> - Get chat history</li>
      <li><strong>DELETE /api/chat/:id/history</strong> - Clear chat history</li>
      <li><strong>GET /api/chat/sessions</strong> - Get all chat sessions</li>
    </ul>
    
    <h2>🌐 Web Interface</h2>
    <p><a href="/index.html" style="color: #667eea; text-decoration: none; font-weight: bold;">→ Open Web Interface</a></p>
    
    <h2>📚 API Documentation</h2>
    <p>All API responses include a <code>success</code> field and proper error handling.</p>
    <p>Example response: <code>{"success": true, "data": {...}, "error": null}</code></p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
