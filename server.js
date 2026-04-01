import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

function buildPrompt(setup = {}, plan = {}) {
  const dest = setup.dest || "Tokyo";
  const from = setup.from || "your city";
  const days = parseInt(setup.days, 10) || 5;
  const month = setup.month || "any month";
  const who = setup.who || "solo";
  const pace = setup.pace || "balanced";
  const prefs = Array.isArray(setup.prefs) ? setup.prefs : [];
  const constraints = setup.constraints || {};
  const budget = setup.budget || 2000;
  const planType = plan?.type || "smart";
  const numDays = Math.min(days, 7);

  const cLines = [];
  if (constraints.no_long_walk) cLines.push("cannot walk more than 30 minutes at a stretch; cluster stops tightly");
  if (constraints.no_early) cLines.push("no activities before 9 AM");
  if (constraints.stroller) cLines.push("stroller-friendly only; avoid steep stairs and rough terrain");
  if (constraints.no_nightlife) cLines.push("no nightlife or late evenings; wrap up by 8 PM");
  if (constraints.rest_zones) cLines.push("needs seated rest zones every 2 hours");
  if (constraints.no_stairs) cLines.push("no lots of stairs or steep climbs");
  if (constraints.dietary) cLines.push("dietary restrictions; flag vegetarian, vegan, or halal options at every meal stop");

  const constraintText = cLines.length ? cLines.join("; ") : "none";

  const paceMap = {
    relaxed: "2-3 activities per day, long breaks",
    balanced: "4-5 activities per day, comfortable pace",
    insane: "7-8 activities per day, minimal downtime",
  };

  const planMap = {
    budget: "Budget Traveler: free or cheap attractions, street food, public transport only",
    smart: "Smart Explorer: mix of free and paid, metro plus occasional cab, mid-range dining",
    luxury: "Luxury Comfort: premium spots, skip-the-line, fine dining, private transfers",
  };

  return `You are TripWise, an expert travel planner. Create a ${numDays}-day itinerary for a trip to ${dest} (from ${from}) in ${month}.

TRAVELLER:
- Who: ${who}
- Interests: ${prefs.length ? prefs.join(", ") : "culture, sightseeing, food"}
- Pace: ${pace} (${paceMap[pace] || paceMap.balanced})
- Plan: ${planMap[planType] || planMap.smart}
- Budget: $${budget} USD total
- Constraints: ${constraintText}

Return ONLY a raw JSON array of exactly ${numDays} day objects. No markdown, no explanation, no backticks.

Each day object schema:
{
  "day": <number>,
  "title": "<3-5 word lowercase theme>",
  "stats": { "activities": <int>, "walkPct": <int 0-100>, "transportCost": <int USD> },
  "reality": "<null or 1-2 honest sentences about the day>",
  "warn": "<null or budget/crowd warning>",
  "activities": [
    {
      "time": "<HH:MM>",
      "title": "<name>",
      "meta": "<area | cost | duration | accessibility>",
      "transport": [{ "type": "<walk|metro|cab|bus|ferry|free>", "label": "<description with time/cost>" }],
      "reality": <null or { "type": "<info|warn>", "text": "<honest tip>" }>
    }
  ]
}

Rules:
1. Match activities to interests: ${prefs.join(", ") || "culture"}.
2. Strictly honour all constraints: ${constraintText}.
3. Activities per day must match pace: ${paceMap[pace] || paceMap.balanced}.
4. Be honest in reality and warn; flag tourist traps and overspend risks.
5. Include specific entry costs, transit times, and walking distances.
6. Spread days across different areas with minimal backtracking.
7. Activities must flow geographically within each day.
8. Return only the raw JSON array.`;
}

function parseItineraryText(text) {
  const cleaned = text.replace(/```json|```/gi, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error("AI did not return a JSON array");
    }
    return JSON.parse(match[0]);
  }
}

function fallbackItinerary(title, meta) {
  return [
    {
      day: 1,
      title,
      stats: { activities: 1, walkPct: 50, transportCost: 10 },
      reality: "The live AI response was unavailable, so this is placeholder data.",
      warn: null,
      activities: [
        {
          time: "09:00",
          title: "Try again shortly",
          meta,
          transport: [],
          reality: null,
        },
      ],
    },
  ];
}

app.post("/generate-itinerary", async (req, res) => {
  const { setup, plan, prompt: incomingPrompt } = req.body || {};

  console.log("API HIT");
  console.log("Incoming request:", setup);

  try {
    const groqApiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;

    if (!groqApiKey) {
      return res.status(500).json({ error: "Missing GROQ_API_KEY in .env" });
    }

    const prompt = incomingPrompt || buildPrompt(setup, plan);

    const response = await fetch(
      GROQ_API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0.7,
          messages: [
            {
              role: "system",
              content: "You are TripWise, an expert travel planner. Return only valid JSON.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      }
    );

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;

    console.log("AI RAW RESPONSE:", text);

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || "Groq request failed",
      });
    }

    if (!text) {
      return res.status(500).json({ error: "No response from Groq" });
    }

    const parsed = parseItineraryText(text);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return res.status(500).json({ error: "AI returned an invalid itinerary" });
    }

    return res.json(parsed);
  } catch (err) {
    console.log("SERVER ERROR:", err);
    return res.json(fallbackItinerary("error fallback", "Try again later"));
  }
});

app.get("/places", async (req, res) => {
  const city = req.query.city;

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=top+places+in+${city}&key=${process.env.GOOGLE_API_KEY}`
    );

    const data = await response.json();
    res.json(data.results);
  } catch {
    res.status(500).json({ error: "Places API failed" });
  }
});

app.get("/", (req, res) => {
  res.send("Server is working");
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
