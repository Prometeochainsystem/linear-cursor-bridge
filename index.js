import express from "express";
import "dotenv/config";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 3000,
  LINEAR_WEBHOOK_SECRET,
  CURSOR_API_KEY,
  REPOSITORY_URL,
  REPOSITORY_BRANCH = "main",
} = process.env;

// Utilità: crea uno slug per il nome branch
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// (Opzionale) verifica firma Linear se usi Signing Secret
function verifyLinearSignature(req) {
  if (!LINEAR_WEBHOOK_SECRET) return true; // disabilitato

  const signature = req.headers["linear-signature"];
  if (!signature) return false;

  const body = JSON.stringify(req.body);
  const hmac = crypto
    .createHmac("sha256", LINEAR_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");

  return signature === hmac;
}

// Mapping Team → ruolo / tipo agent
function roleFromTeamKey(teamKey) {
  switch (teamKey) {
    case "PM":
      return "AI Project Manager";
    case "UX":
      return "UI/UX Designer";
    case "FE":
      return "Frontend Developer";
    case "BE":
      return "Backend Developer";
    case "BC":
      return "Blockchain Developer";
    case "DO":
      return "DevOps Engineer";
    case "QA":
      return "QA / Tester";
    default:
      return "Generic AI Developer";
  }
}

// Costruisce il prompt per l’agent di Cursor partendo dall’issue Linear
function buildPromptFromIssue(issue, teamKey) {
  const role = roleFromTeamKey(teamKey);

  const identifier = issue.identifier ?? issue.id;
  const title = issue.title ?? "Untitled";
  const description = issue.description ?? "";
  const linearUrl = issue.url ?? "";

  return `
You are a ${role} working inside a real production codebase.

Your task is derived from a Linear issue:

- Linear ID: ${identifier}
- Title: ${title}
- Team: ${teamKey}
- Linear URL: ${linearUrl}

Issue description (from product / PM):

${description}

Requirements:
- Analyze the current repository state.
- Plan the minimal set of changes needed.
- Implement the solution directly in the codebase.
- Follow existing patterns, architecture and style.
- Add or update tests when necessary.
- Keep changes focused on this issue only.

Deliverables:
- Updated code implementing the requested feature/fix.
- Any necessary configuration changes.
- Tests updated or added when appropriate.

Work step-by-step inside the repository and keep changes clean and consistent.
`;
}

// Chiama la Cloud Agents API di Cursor per lanciare un agent sul repo
async function launchCursorAgent(promptText, branchName, metadata = {}) {
  if (!CURSOR_API_KEY) {
    console.error("Missing CURSOR_API_KEY in env");
    return null;
  }
  if (!REPOSITORY_URL) {
    console.error("Missing REPOSITORY_URL in env");
    return null;
  }

  const body = {
    prompt: {
      text: promptText,
    },
    source: {
      repository: REPOSITORY_URL,
      ref: REPOSITORY_BRANCH,
    },
    target: {
      branchName,
      autoCreatePr: true,
    },
    metadata,
  };

  const res = await fetch("https://api.cursor.com/v0/agents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CURSOR_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Cursor API error:", res.status, text);
    throw new Error(`Cursor API failed: ${res.status}`);
  }

  const json = await res.json();
  console.log("Launched Cursor agent:", json.id, json.status);
  return json;
}

// Endpoint Webhook da inserire in Linear
app.post("/webhooks/linear", async (req, res) => {
  try {
    if (!verifyLinearSignature(req)) {
      console.warn("Invalid Linear signature");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;
    const { type, action, data } = event;

    console.log("Linear event received:", type, action);

    // 1) Gestione ISSUE
    if (type === "Issue" && (action === "create" || action === "update")) {
      const issue = data;
      const teamKey = issue.team?.key || issue.teamKey || "GEN";
      const identifier = issue.identifier || issue.id;

      // Regola semplice: attiva agent solo se è in uno stato specifico o ha una label
      const labels = (issue.labels || []).map((l) => l.name);
      const stateName = issue.state?.name || "";

      const shouldRunAgent =
        labels.includes("ready-for-ai") ||
        stateName.toLowerCase() === "in progress";

      if (!shouldRunAgent) {
        console.log(
          `Issue ${identifier} ignorata (niente label ready-for-ai / stato In Progress)`
        );
        return res.status(200).send("Ignored");
      }

      const promptText = buildPromptFromIssue(issue, teamKey);
      const branchName =
        `${teamKey.toLowerCase()}-${identifier}-${slugify(issue.title)}`.slice(
          0,
          60
        );

      const agent = await launchCursorAgent(promptText, branchName, {
        linearIssueId: issue.id,
        linearIdentifier: identifier,
        linearTeamKey: teamKey,
      });

      return res.status(200).json({ ok: true, agentId: agent?.id });
    }

    // 2) Gestione COMMENTI tipo "/run-agent"
    if (type === "Comment" && action === "create") {
      const comment = data;
      const body = comment.body || "";
      const issue = comment.issue;

      if (!body.startsWith("/run-agent")) {
        return res.status(200).send("Comment ignored");
      }

      const teamKey = issue?.team?.key || "GEN";
      const identifier = issue?.identifier || issue?.id || "unknown";

      const promptText = buildPromptFromIssue(issue, teamKey);
      const branchName =
        `${teamKey.toLowerCase()}-${identifier}-${slugify(
          issue?.title || "comment-run"
        )}`.slice(0, 60);

      const agent = await launchCursorAgent(promptText, branchName, {
        linearIssueId: issue?.id,
        linearIdentifier: identifier,
        triggerCommentId: comment.id,
      });

      return res.status(200).json({ ok: true, agentId: agent?.id });
    }

    // Altri eventi → OK ma non fanno nulla
    return res.status(200).send("Event ignored");
  } catch (err) {
    console.error("Error handling Linear webhook:", err);
    return res.status(500).send("Internal error");
  }
});

app.get("/", (_req, res) => {
  res.send("Linear → Cursor bridge is running");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
