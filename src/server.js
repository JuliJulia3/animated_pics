import express from "express";
import multer from "multer";
import sharp from "sharp";
import heicConvert from "heic-convert";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

// Accept uploads up to 12MB each
const upload = multer({
  limits: { fileSize: 12 * 1024 * 1024 },
});

app.get("/", (req, res) => {
  res
    .type("text")
    .send(
      "OK. GET /health. POST /v1/funko-bmw (multipart: face optional, bike optional, style optional, character optional, variant optional)."
    );
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Random avatar presets (used if no face AND no character is provided)
const AVATAR_PRESETS = [
  "young adult with short dark hair, casual streetwear",
  "young adult with curly hair, hoodie and sneakers",
  "female with long hair, denim jacket, friendly smile",
  "male with buzz cut, black t-shirt, confident pose",
  "person with glasses, neat hairstyle, minimalist outfit",
  "person with a beanie, oversized sweater, relaxed vibe",
  "athletic person, ponytail, sporty outfit",
  "person with freckles, short hair, casual jacket",
];

// R1300 variants prompt cues
function variantTextAndCues(variantRaw) {
  const v = (variantRaw || "r1300gs").toLowerCase().trim();
  const allowed = new Set(["r1300gs", "r1300gs_adventure"]);
  if (!allowed.has(v)) return null;

  const bikeText = v === "r1300gs_adventure" ? "BMW R1300GS Adventure" : "BMW R1300GS";
  const variantCues =
    v === "r1300gs_adventure"
      ? "Adventure variant cues: taller windscreen, more rugged adventure stance, larger upper body presence."
      : "Standard GS cues: cleaner/lighter silhouette than the Adventure variant.";
  return { v, bikeText, variantCues };
}

async function toPngBuffer(file) {
  const mime = (file.mimetype || "").toLowerCase();
  const name = (file.originalname || "").toLowerCase();

  const isHeic =
    mime === "image/heic" ||
    mime === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif");

  // Try sharp first
  try {
    return await sharp(file.buffer, { animated: false })
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch (err) {
    // HEIC fallback
    if (!isHeic) throw err;

    const converted = await heicConvert({
      buffer: file.buffer,
      format: "PNG",
    });

    return await sharp(Buffer.from(converted))
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  }
}

function pickRandomAvatar() {
  return AVATAR_PRESETS[crypto.randomInt(0, AVATAR_PRESETS.length)];
}

app.post(
  "/v1/funko-bmw",
  upload.fields([
    { name: "face", maxCount: 1 },  // optional
    { name: "bike", maxCount: 1 },  // optional (recommended)
    { name: "style", maxCount: 1 }, // optional
  ]),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
      }

      const face = req.files?.face?.[0] || null;
      const bike = req.files?.bike?.[0] || null;
      const style = req.files?.style?.[0] || null;

      // New: word/description input when no face
      const characterInput = (req.body?.character || "").toString().trim();

      // Bike variant selector
      const vt = variantTextAndCues(req.body?.variant);
      if (!vt) {
        return res.status(400).json({
          error: "Invalid variant. Use r1300gs or r1300gs_adventure.",
        });
      }
      const { bikeText, variantCues } = vt;

      const background = (req.body?.background || "white").toLowerCase().trim();

      // Decide character source
      let characterDesc = "";
      if (face) {
        characterDesc =
          "Use IMAGE 1 (face) to preserve the person’s identity (face shape, hair, eyebrows).";
      } else if (characterInput) {
        characterDesc =
          `Create the character from this description/word: "${characterInput}". ` +
          "Make it a cute vinyl toy (Funko Pop style) character that matches that description.";
      } else {
        const randomAvatar = pickRandomAvatar();
        characterDesc =
          `Create a random but appealing character (no real person likeness) with this description: "${randomAvatar}". ` +
          "Cute vinyl toy (Funko Pop style).";
      }

      // Decide bike source
      // If bike image provided -> preserve silhouette from it.
      // If not -> generate bike from prompt using variant.
      const bikeDesc = bike
        ? "Use the motorcycle reference image to preserve the motorcycle silhouette and key design details."
        : `Generate a ${bikeText} motorcycle in the same vinyl toy style.`;

      const prompt = `
Create a cute vinyl toy character and BMW motorcycle illustration.
Match the style of the provided style reference if present: big head, simplified features, glossy plastic, clean bold outlines, soft studio shadow.
${characterDesc}
${bikeDesc}
The motorcycle must look like a ${bikeText}. ${variantCues}
Keep the BMW roundel visible if it appears in the reference or add it subtly.
Full body character standing next to the bike, 3/4 view, centered composition.
Background: ${background === "transparent" ? "transparent background" : "plain white background"}.
No realistic photo look. No text. No watermark. No extra people. No extra bikes.
      `.trim();

      // Normalize images to PNG if present
      const facePng = face ? await toPngBuffer(face) : null;
      const bikePng = bike ? await toPngBuffer(bike) : null;
      const stylePng = style ? await toPngBuffer(style) : null;

      // Build multipart for OpenAI
      const form = new FormData();

      // IMPORTANT: multiple images must use array syntax: image[]
      // Ordering:
      // - If face exists, it should be first (identity)
      // - Bike second (shape)
      // - Style last (style lock)
      if (facePng) form.append("image[]", new Blob([facePng], { type: "image/png" }), "face.png");
      if (bikePng) form.append("image[]", new Blob([bikePng], { type: "image/png" }), "bike.png");
      if (stylePng) form.append("image[]", new Blob([stylePng], { type: "image/png" }), "style.png");

      form.append("model", "gpt-image-1.5");
      form.append("prompt", prompt);
      form.append("quality", "medium");
      form.append("size", "1024x1024");
      form.append("output_format", "png");

      // If no images were provided at all, this still works with some setups,
      // but safest is: require at least one of (face, bike, style).
      // We'll enforce that to avoid weird behavior.
      if (!facePng && !bikePng && !stylePng) {
        return res.status(400).json({
          error: "Provide at least one image: face, bike, or style. (Recommended: bike.)",
        });
      }

      const r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
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