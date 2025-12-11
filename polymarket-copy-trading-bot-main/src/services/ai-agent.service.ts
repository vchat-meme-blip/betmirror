import { GoogleGenAI } from "@google/genai";

export interface AnalysisResult {
  shouldCopy: boolean;
  reasoning: string;
  riskScore: number;
}

export type RiskProfile = 'conservative' | 'balanced' | 'degen';

export class AiAgentService {
  private ai: GoogleGenAI;
  private model: string = "gemini-2.5-flash";

  constructor() {
    // API key must be exclusively obtained from process.env.API_KEY
    this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  }

  async analyzeTrade(
    marketQuestion: string,
    tradeSide: "BUY" | "SELL",
    outcome: "YES" | "NO",
    size: number,
    price: number,
    riskProfile: RiskProfile = 'balanced'
  ): Promise<AnalysisResult> {
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
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
        },
      });

      const text = response.text;
      if (!text) throw new Error("No response from AI");

      // Gemini sometimes wraps JSON in markdown blocks like ```json ... ```
      const cleanText = text.replace(/```json\n?|```/g, '').trim();
      
      return JSON.parse(cleanText) as AnalysisResult;
    } catch (error) {
      console.error("AI Analysis failed:", error);
      // Fail safe: If AI fails, we default to blocking the trade in Conservative mode, but allowing in others if critical
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