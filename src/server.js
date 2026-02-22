import express from "express";
import multer from "multer";
import sharp from "sharp";
import heicConvert from "heic-convert";

const app = express();
const PORT = process.env.PORT || 3000;

// Accept uploads up to 12MB each (adjust if you want)
const upload = multer({
  limits: { fileSize: 12 * 1024 * 1024 }
});

app.get("/", (req, res) => {
  res.type("text").send(
    "OK. GET /health. POST /v1/funko-bmw (multipart: face, bike, optional style, optional variant, optional background)."
  );
});

app.get("/health", (req, res) => res.json({ ok: true }));

async function toPngBuffer(file) {
  const mime = (file.mimetype || "").toLowerCase();
  const name = (file.originalname || "").toLowerCase();

  const isHeic =
    mime === "image/heic" ||
    mime === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif");

  // Try sharp first (covers jpg/png/webp/tiff/bmp/gif static)
  try {
    return await sharp(file.buffer, { animated: false })
      .rotate() // fixes EXIF orientation (iPhone)
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true
      })
      .png()
      .toBuffer();
  } catch (err) {
    // HEIC fallback (works even if sharp can't decode HEIC on the host)
    if (!isHeic) throw err;

    const converted = await heicConvert({
      buffer: file.buffer,
      format: "PNG"
    });

    return await sharp(Buffer.from(converted))
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true
      })
      .png()
      .toBuffer();
  }
}

app.post(
  "/v1/funko-bmw",
  upload.fields([
    { name: "face", maxCount: 1 },
    { name: "bike", maxCount: 1 },
    { name: "style", maxCount: 1 }
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

      const bikeText =
        variant === "r1300gs_adventure" ? "BMW R1300GS Adventure" : "BMW R1300GS";

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

      // Normalize inputs to PNG
      const facePng = await toPngBuffer(face);
      const bikePng = await toPngBuffer(bike);
      const stylePng = style ? await toPngBuffer(style) : null;

      // ✅ Native FormData + Blob (Node 22). Do NOT set Content-Type manually.
      const form = new FormData();
      form.append("image[]", new Blob([facePng], { type: "image/png" }), "face.png");
      form.append("image[]", new Blob([bikePng], { type: "image/png" }), "bike.png");
      if (stylePng) {
        form.append("image[]", new Blob([stylePng], { type: "image/png" }), "style.png");
      }

      form.append("model", "gpt-image-1.5");
      form.append("prompt", prompt);
      form.append("quality", "medium");
      form.append("size", "1024x1024");
      form.append("output_format", "png");

      const r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
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