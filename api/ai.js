export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt, provider } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    if (provider === "gemini") {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
          }),
        }
      );

      const data = await response.json();
      const text =
        data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response";

      return res.status(200).json({ response: text });
    }

    if (provider === "openai") {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
          }),
        }
      );

      const data = await response.json();
      const text =
        data?.choices?.[0]?.message?.content || "No response";

      return res.status(200).json({ response: text });
    }

    return res.status(400).json({ error: "Invalid provider" });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
