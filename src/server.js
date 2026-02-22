import express from "express";
import multer from "multer";
import FormData from "form-data";

const app = express();

// Render provides PORT
const PORT = process.env.PORT || 3000;

// IMPORTANT: uploads come through multipart, so we use multer.
// Keep fileSize reasonable to avoid proxy limits / timeouts.
const upload = multer({
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB each
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.post(
  "/v1/funko-bmw",
  upload.fields([
    { name: "face", maxCount: 1 },
    { name: "bike", maxCount: 1 },
    { name: "style", maxCount: 1 } // optional: your example style image
  ]),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
      }

      const face = req.files?.face?.[0];
      const bike = req.files?.bike?.[0];
      const style = req.files?.style?.[0]; // optional
      if (!face || !bike) {
        return res.status(400).json({ error: "You must upload face + bike images" });
      }

      const variant = (req.body?.variant || "r1300gs").toLowerCase();
      const background = (req.body?.background || "white").toLowerCase();

      const bikeText = variant === "r1300gs_adventure"
        ? "BMW R1300GS Adventure"
        : "BMW R1300GS";

      const prompt = `
Create a cute vinyl toy character and BMW motorcycle illustration.
Match the style of the provided style reference if present: big head, simplified features, glossy plastic, clean bold outlines, soft studio shadow.
Use IMAGE 1 (face) to preserve the person’s identity (face shape, hair, eyebrows).
Use IMAGE 2 (motorcycle) to preserve the motorcycle silhouette and key design details.
The motorcycle must look like a ${bikeText}.
Keep the BMW roundel visible if it appears in the reference.
Full body character standing next to the bike, 3/4 view, centered composition.
Background: ${background === "transparent" ? "transparent background" : "plain white background"}.
No realistic photo look. No text. No watermark. No extra people. No extra bikes.
      `.trim();

      const form = new FormData();

      // The edits endpoint supports multiple `image` parts.
      form.append("image", face.buffer, { filename: "face.png", contentType: face.mimetype });
      form.append("image", bike.buffer, { filename: "bike.png", contentType: bike.mimetype });

      if (style) {
        form.append("image", style.buffer, { filename: "style.png", contentType: style.mimetype });
      }

      form.append("model", "gpt-image-1.5");
      form.append("prompt", prompt);
      form.append("quality", "medium");
      form.append("size", "1024x1024");
      form.append("output_format", "png");

      const r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      });

      if (!r.ok) {
        const details = await r.text();
        return res.status(r.status).json({ error: "OpenAI request failed", details });
      }

      const json = await r.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) return res.status(500).json({ error: "No image returned" });

      const img = Buffer.from(b64, "base64");
      res.setHeader("Content-Type", "image/png");
      return res.send(img);

    } catch (err) {
      return res.status(500).json({ error: "Server error", details: String(err) });
    }
  }
);


app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});


