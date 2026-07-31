import { GoogleGenerativeAI } from "@google/generative-ai";
import { messagingApi } from "@line/bot-sdk";
import { Redis } from "@upstash/redis";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/index.js";

let geminiClient: GoogleGenerativeAI | null = null;
let redisClient: Redis | null = null;
let supabaseClient: SupabaseClient | null = null;
let lineClient: messagingApi.MessagingApiClient | null = null;

export function isGeminiConfigured(): boolean {
  return Boolean(config.gemini.apiKey);
}

export function getGeminiClient(): GoogleGenerativeAI {
  if (!config.gemini.apiKey) {
    throw new Error("[Config] GEMINI_API_KEY is not configured.");
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
  }

  return geminiClient;
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      url: config.redis.restUrl,
      token: config.redis.restToken,
    });
  }

  return redisClient;
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      { auth: { persistSession: false } }
    );
  }

  return supabaseClient;
}

export function getLineClient(): messagingApi.MessagingApiClient {
  if (!lineClient) {
    lineClient = new messagingApi.MessagingApiClient({
      channelAccessToken: config.line.channelAccessToken,
    });
  }

  return lineClient;
}

export function resetServiceClientsForTests(): void {
  geminiClient = null;
  redisClient = null;
  supabaseClient = null;
  lineClient = null;
}