// Load .env from the same directory as server.js
const _path = require("path");
const dotenvResult = require("dotenv").config({ path: _path.join(__dirname, ".env") });
if (dotenvResult.error) {
  // .env file missing is OK if env vars are set another way (e.g. system env)
  if (dotenvResult.error.code !== "ENOENT") {
    console.warn("[dotenv] Warning:", dotenvResult.error.message);
  }
} else {
  console.log("[dotenv] Loaded .env file successfully");
}

var https = require("https");
var express = require("express");
var path = require("path");
var helmet = require("helmet");
var cors = require("cors");
var rateLimit = require("express-rate-limit");

var app = express();
var PORT = process.env.PORT || 3000;

// ── Security & parsing middleware ──────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // disabled because index.html uses inline <style>/<script>;
                                // tighten this with nonces/hashes if you lock down the frontend later
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true // set ALLOWED_ORIGIN in .env for production
}));
app.use(express.json({ limit: "200kb" })); // cap payload size — prevents huge/abusive bodies
app.use(express.static(__dirname));

// ── Rate limiting on the AI endpoint (protects your Groq quota/cost) ──
var chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // 20 requests/min per IP — adjust to taste
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." }
});

// ── Model config ────────────────────────────────────────────────
// llama-3.3-70b-versatile was deprecated by Groq (announced June 17, 2026).
// Primary + fallback per Groq's own migration guidance:
// https://console.groq.com/docs/deprecations
// Valid Groq model IDs (check https://console.groq.com/docs/models for latest)
var PRIMARY_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
var FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || "llama3-8b-8192";

var KEY = process.env.GROQ_API_KEY || "";
console.log("=================================");
console.log("  CareerPilot - Powered by Groq  ");
console.log("=================================");
console.log("  Key set: " + (KEY ? "YES " + KEY.slice(0, 8) + "..." : "NO - create a .env file with GROQ_API_KEY=gsk_..."));
console.log("  Model:   " + PRIMARY_MODEL + " (fallback: " + FALLBACK_MODEL + ")");
console.log("=================================\n");

function callGroq(model, system, messages) {
  return new Promise(function (resolve, reject) {
    var payload = JSON.stringify({
      model: model,
      messages: [{ role: "system", content: system }].concat(messages),
      max_tokens: 1500,
      temperature: 0.7
    });

    var opts = {
      hostname: "api.groq.com",
      port: 443,
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": "Bearer " + KEY
      }
    };

    // Hard timeout: without this, a stalled/slow Groq connection leaves the
    // request open forever, the /api/chat handler never responds, and the
    // page just spins (loadTip() fires this on every boot).
    var REQUEST_TIMEOUT_MS = 15000;
    var settled = false;
    var timeoutId = setTimeout(function () {
      settled = true;
      r.destroy();
      reject(Object.assign(new Error("Groq request timed out after " + (REQUEST_TIMEOUT_MS / 1000) + "s"), { status: 504 }));
    }, REQUEST_TIMEOUT_MS);

    var r = https.request(opts, function (apiRes) {
      var d = "";
      apiRes.on("data", function (c) { d += c; });
      apiRes.on("end", function () {
        clearTimeout(timeoutId);
        try {
          var parsed = JSON.parse(d);
          if (parsed.error) {
            return reject(Object.assign(new Error(parsed.error.message || "Groq error"), {
              code: parsed.error.code,
              status: apiRes.statusCode
            }));
          }
          var text = "";
          if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
            text = parsed.choices[0].message.content || "";
          }
          resolve(text);
        } catch (e) {
          reject(new Error("Parse error: " + d.slice(0, 200)));
        }
      });
    });

    r.on("error", function (e) {
      if (settled) return; // already timed out — don't reject twice
      clearTimeout(timeoutId);
      reject(new Error("Network error: " + e.message));
    });
    r.write(payload);
    r.end();
  });
}

app.post("/api/chat", chatLimiter, async function (req, res) {
  if (!KEY) {
    return res.status(500).json({
      error: "Groq API key not set.\nCreate a .env file (see .env.example) with:\nGROQ_API_KEY=gsk_..."
    });
  }

  var system = req.body.system;
  var messages = req.body.messages;

  // ── Basic input validation — reject malformed/oversized requests early ──
  if (system !== undefined && typeof system !== "string") {
    return res.status(400).json({ error: "`system` must be a string." });
  }
  if (messages !== undefined && !Array.isArray(messages)) {
    return res.status(400).json({ error: "`messages` must be an array." });
  }
  system = (system || "You are a helpful assistant.").slice(0, 4000);
  messages = (messages || []).slice(-30)
    .filter(function(m) { return m && (m.role === "user" || m.role === "assistant") && m.content; })
    .map(function (m) {
      return {
        role: m.role,
        content: String(m.content).slice(0, 8000)
      };
    });
  // Groq requires alternating user/assistant — ensure it starts with user
  if (messages.length && messages[0].role !== "user") messages = messages.slice(1);

  console.log("Calling Groq (" + PRIMARY_MODEL + ")...");
  try {
    var text = await callGroq(PRIMARY_MODEL, system, messages);
    console.log("Success! Response length:", text.length);
    return res.json({ content: [{ type: "text", text: text }] });
  } catch (err) {
    console.log("Primary model failed:", err.message);
    // Fall back automatically if the primary model is unavailable/decommissioned
    if (err.code === "model_decommissioned" || err.status >= 500) {
      try {
        console.log("Retrying with fallback model (" + FALLBACK_MODEL + ")...");
        var fbText = await callGroq(FALLBACK_MODEL, system, messages);
        console.log("Fallback success! Response length:", fbText.length);
        return res.json({ content: [{ type: "text", text: fbText }] });
      } catch (fbErr) {
        console.log("Fallback also failed:", fbErr.message);
        return res.status(502).json({ error: fbErr.message });
      }
    }
    return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
  }
});

app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, function () {
  console.log("  Running at http://localhost:" + PORT + "\n");
});