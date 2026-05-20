const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
  // Wait, there's no list models method in GoogleGenerativeAI client directly.
  // It's exposed via REST API, but not necessarily SDK.
  // Let's just do a simple fetch to the REST API.
  const apiKey = process.env.GEMINI_API_KEY;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const data = await res.json();
  const embedModels = data.models.filter(m => m.name.includes('embed'));
  console.log(embedModels.map(m => m.name));
}
listModels();
