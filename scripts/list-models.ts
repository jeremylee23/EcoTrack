import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function listModels() {
  const models = await ai.models.list();
  for await (const model of models) {
    if (model.name.includes('embed')) {
      console.log(model.name, model.supportedGenerationMethods);
    }
  }
}
listModels();
