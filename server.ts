import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

// Body parser
app.use(express.json({ limit: "15mb" }));

// Lazy initializer for Google Gemini API Client
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "MY_GEMINI_API_KEY" || key.trim() === "") {
       throw new Error("GEMINI_API_KEY is not configured in secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// API Endpoints
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// JSON File Database Setup for bookings and partners
const BOOKINGS_FILE = path.join(process.cwd(), "bookings.json");
const PARTNERS_FILE = path.join(process.cwd(), "partners.json");

import fs from "fs";

function readJsonFile<T>(filePath: string, defaultVal: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultVal;
    }
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as T;
  } catch (error) {
    console.error(`Error reading database file at ${filePath}:`, error);
    return defaultVal;
  }
}

function writeJsonFile<T>(filePath: string, data: T): void {
  try {
    // Ensure the parent directory exists if any is specified, though process.cwd() is flat here
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error(`Error writing database file at ${filePath}:`, error);
  }
}

// REST endpoints for Bookings
app.get("/api/bookings", (req, res) => {
  const data = readJsonFile<any[]>(BOOKINGS_FILE, []);
  res.json(data);
});

app.post("/api/bookings", (req, res) => {
  const newBooking = req.body;
  if (!newBooking || !newBooking.id) {
    return res.status(400).json({ error: "Invalid booking dynamic payload" });
  }
  const current = readJsonFile<any[]>(BOOKINGS_FILE, []);
  // Deduplicate on id
  const filtered = current.filter(b => b.id !== newBooking.id);
  const updated = [newBooking, ...filtered];
  writeJsonFile(BOOKINGS_FILE, updated);
  res.json(updated);
});

app.delete("/api/bookings/:id", (req, res) => {
  const { id } = req.params;
  const current = readJsonFile<any[]>(BOOKINGS_FILE, []);
  const updated = current.filter(b => b.id !== id);
  writeJsonFile(BOOKINGS_FILE, updated);
  res.json(updated);
});

// REST endpoints for Partner Applications
app.get("/api/partners", (req, res) => {
  const data = readJsonFile<any[]>(PARTNERS_FILE, []);
  res.json(data);
});

app.post("/api/partners", (req, res) => {
  const newPartner = req.body;
  if (!newPartner || !newPartner.name) {
    return res.status(400).json({ error: "Missing professional name attribute" });
  }
  const partnerWithMeta = {
    id: "part_" + Date.now(),
    name: newPartner.name,
    specialty: newPartner.specialty || "Editorial Hair",
    experience: newPartner.experience || "5+ Years",
    portfolioUploaded: !!newPartner.portfolioUploaded,
    status: "In Selection Vetting",
    createdAt: new Date().toISOString()
  };
  const current = readJsonFile<any[]>(PARTNERS_FILE, []);
  const updated = [partnerWithMeta, ...current];
  writeJsonFile(PARTNERS_FILE, updated);
  res.json({ success: true, partner: partnerWithMeta, collective: updated });
});

app.post("/api/analyze-face", async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64 payload" });
    }

    // Try utilizing the genuine Gemini client
    const ai = getGeminiClient();
    
    // Clean base64 header if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const actualMimeType = mimeType || "image/jpeg";

    const promptText = `
      You are an expert AI stylist and aesthetician for Koregaon Park's high-end boutique UrbanSalon. 
      Analyze this user's facial features and provide professional luxury styling recommendations.
      Identify:
      1. Their Face Shape (e.g., "Oval-Heart Hybrid", "Classic Oval", "Defined Square", "Symmetrical Diamond", "Soft Round").
      2. Estimated Skin Tone (with representative code e.g. "Warm Olive (V-2)", "Fair Cool (P-1)", "Medium Warm (W-3)", "Deep Neutral (C-4)").
      3. Style recommendations tailored specifically to their face shape, including:
         - A Primary Recommendation with name (e.g. "Structured Glass Bob" or a highly suitable custom name), matching percentage, trending status (true/false) and reasons why it fits them.
         - Two Sub-recommendations (e.g., "Curtain Fringe", "Sleek Taper", "Beachy Balayage Waves", "Textured Pixie") with name and brief description.
      
      Respond STRICTLY in a JSON format matching the schema requested. Keep answers sophisticated, calm, and luxury-branded.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          inlineData: {
            data: base64Data,
            mimeType: actualMimeType
          }
        },
        { text: promptText }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["faceShape", "skinTone", "primaryRecommendation", "subRecommendations"],
          properties: {
            faceShape: { type: Type.STRING },
            skinTone: { type: Type.STRING },
            primaryRecommendation: {
              type: Type.OBJECT,
              required: ["name", "matchPercentage", "isTrending", "description", "reasons"],
              properties: {
                name: { type: Type.STRING },
                matchPercentage: { type: Type.INTEGER },
                isTrending: { type: Type.BOOLEAN },
                description: { type: Type.STRING },
                reasons: { type: Type.STRING }
              }
            },
            subRecommendations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["name", "description"],
                properties: {
                  name: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              }
            }
          }
        }
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("No response from Gemini.");
    }

    const payload = JSON.parse(resultText);
    return res.json(payload);

  } catch (err: any) {
    console.error("Gemini AI Analysis Error:", err.message);
    
    // Graceful fallback for simulation if API Key is not set or request fails
    // This protects the user experience while letting them know they can enable keys
    const fallbackShapes = ["Oval-Heart Hybrid", "Symmetrical Diamond", "Defined Square", "Soft Round", "Classic Oval"];
    const fallbackTones = ["Warm Olive (V-2)", "Fair Cool (P-1)", "Medium Warm (W-3)", "Olive Glow (V-2)"];
    
    const randomShape = fallbackShapes[Math.floor(Math.random() * fallbackShapes.length)];
    const randomTone = fallbackTones[Math.floor(Math.random() * fallbackTones.length)];

    return res.json({
      faceShape: randomShape,
      skinTone: randomTone,
      isSimulation: true,
      simulationNotice: "Simulated analysis. Configure your GEMINI_API_KEY in Secrets for live AI features.",
      primaryRecommendation: {
        name: "Structured Glass Bob",
        matchPercentage: 98,
        isTrending: true,
        description: "Perfect for your face shape and density.",
        reasons: "Maintains strong architectural structure that frames the jawline perfectly, adding premium movement and custom definition."
      },
      subRecommendations: [
        {
          name: "Curtain Fringe",
          description: "Softer frame that beautifully balances the hybrid cheekbone structure."
        },
        {
          name: "Sleek Taper",
          description: "Clean, low-maintenance aesthetic highlighting your jawline precision."
        }
      ]
    });
  }
});


async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    // Mount Vite middleware
    app.use(vite.middlewares);
  } else {
    // Serve static files in build
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
