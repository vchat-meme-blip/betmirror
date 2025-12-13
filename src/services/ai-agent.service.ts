
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

export interface AnalysisResult {
  shouldCopy: boolean;
  reasoning: string;
  riskScore: number;
}

export type RiskProfile = 'conservative' | 'balanced' | 'degen';

export class AiAgentService {
  private model: string = "gemini-2.5-flash";

  async analyzeTrade(
    marketQuestion: string,
    tradeSide: "BUY" | "SELL",
    outcome: "YES" | "NO",
    size: number,
    price: number,
    riskProfile: RiskProfile = 'balanced',
    apiKey?: string
  ): Promise<AnalysisResult> {
    
    // Use provided key, or fall back to process.env
    const keyToUse = apiKey || process.env.API_KEY;

    // FIX: If no API key is provided, bypass AI and allow the trade directly.
    if (!keyToUse) {
        return {
            shouldCopy: true,
            reasoning: "AI Bypass: No API Key provided. Trade allowed.",
            riskScore: 0
        };
    }

    const ai = new GoogleGenAI({ apiKey: keyToUse });

    const systemInstruction = `You are a specialized Risk Analyst Agent for a prediction market trading bot. 
    Your Risk Profile is: ${riskProfile.toUpperCase()}.
    
    Profiles:
    - CONSERVATIVE: Only approve trades with high certainty, obvious fundamentals, and stable prices (0.20 - 0.80). Reject highly speculative or volatile bets.
    - BALANCED: Standard risk management. Evaluate EV (Expected Value) and liquidity.
    - DEGEN: Approve almost anything unless it's a guaranteed loss or rug pull. High volatility is acceptable.
    
    Output strictly in JSON format.`;

    const prompt = `
      Analyze this signal:
      Market ID/Question: "${marketQuestion}"
      Signal: ${tradeSide} ${outcome}
      Price: ${price} (Implied Probability: ${(price * 100).toFixed(1)}%)
      Position Size: $${size}
      
      Decide if we should copy this trade based on the ${riskProfile} profile.
      Return JSON only: { "shouldCopy": boolean, "reasoning": "short explanation", "riskScore": number (1-10) }
    `;

    try {
      const response: GenerateContentResponse = await ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
        },
      });

      const text = response.text;
      if (!text) throw new Error("No response from AI");

      const cleanText = text.replace(/```json\n?|```/g, '').trim();
      
      return JSON.parse(cleanText) as AnalysisResult;
    } catch (error) {
      console.error("AI Analysis failed:", error);
      const fallbackDecision = riskProfile === 'degen';
      return { 
        shouldCopy: fallbackDecision, 
        reasoning: `AI Analysis Failed (${String(error)}). Defaulting to ${fallbackDecision ? 'COPY' : 'SKIP'}.`, 
        riskScore: 5 
      };
    }
  }
}

export const aiAgent = new AiAgentService();
