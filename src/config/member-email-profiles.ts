import type { MemberId } from "./members";

/**
 * VERIFIED facts each member's email drafts may use. Nothing outside this file (and config/members.ts for name and
 * links) may appear in a draft as a claim about the member. Skill ids refer to config/skills.ts.
 *
 * Sources:
 *  - anni: his resume stored in JobSync (Profile → Resumes).
 *  - lukky: the reference email he wrote himself (no resume stored yet) — only what it states.
 *  - rishii: nothing verified yet (no resume or profile) — his drafts make no specific skill claims.
 * Update this file when a member's resume changes.
 */
export interface Highlight {
  /** e.g. "RealPath (AI Resume Builder & ATS Analyzer)" or "AI Intern at Codec Technologies". */
  title: string;
  kind: "project" | "experience";
  /** Completes "…, where I …" (first person, past tense, factual). */
  didWhat: string;
  skills: readonly string[];
}

export interface MemberEmailProfile {
  /** Completes "I am a …". Empty = no education sentence. */
  education: string;
  /** Approved skill ids (subset of config/skills.ts) the member can genuinely claim. */
  skills: readonly string[];
  highlights: readonly Highlight[];
  /** Short factual achievements (optional, used sparingly). */
  achievements: readonly string[];
  /** Where the member is based (only mentioned when a role's location/work mode makes it relevant). */
  location: string;
}

export const MEMBER_EMAIL_PROFILES: Record<MemberId, MemberEmailProfile> = {
  anni: {
    education: "final-year B.Tech Computer Science (AI & Data Science) student at IIIT Manipur, graduating in 2027, and a full-stack developer with three internships",
    skills: [
      "javascript", "typescript", "python", "sql", "cpp",
      "react", "nextjs", "redux", "html", "css", "tailwind", "bootstrap", "responsive", "component-architecture", "reusable-components", "frontend-performance", "ui-development", "state-management", "web-push",
      "nodejs", "express", "fastapi", "rest-apis", "api-integration", "websockets", "webrtc", "jwt", "webhooks", "backend-development", "authentication", "authorization", "session-management", "http-only-cookies", "access-control", "api-documentation", "google-sheets-api",
      "mongodb", "postgresql", "mysql", "redis", "firebase", "supabase", "nosql", "relational-databases",
      "git", "github", "docker", "ci-cd", "github-actions", "vercel", "render", "aws", "cloud-deployment",
      "oop", "data-structures", "algorithms", "debugging", "unit-testing", "integration-testing", "code-review", "agile", "jira", "postman", "performance-optimization", "competitive-programming", "problem-solving",
      "openai-api", "gemini-api", "llms", "langchain", "langgraph", "rag", "ai-agents", "llm-integration", "workflow-automation", "ai-apps", "prompt-engineering", "context-engineering", "embeddings", "chunking", "indexing", "retrieval-pipelines", "ai-workflow-automation", "ai-resume-analysis", "computer-vision", "deep-learning", "automated-reporting",
      "flutter", "mobile-development", "mobile-api",
    ],
    highlights: [
      { title: "Web Developer Intern at Amdox Technologies", kind: "experience", didWhat: "built responsive web applications with React.js and Node.js, integrated REST APIs end to end and improved page-load performance", skills: ["react", "nodejs", "rest-apis", "responsive", "frontend-performance", "code-review", "agile"] },
      { title: "AI Intern (Backend & APIs) at Codec Technologies", kind: "experience", didWhat: "built Python backend services and documented REST APIs with retrieval pipelines (chunking, indexing and embeddings), and automated reporting workflows that cut manual effort by 60%", skills: ["python", "rest-apis", "api-documentation", "retrieval-pipelines", "chunking", "indexing", "embeddings", "rag", "prompt-engineering", "context-engineering", "automated-reporting", "ai-workflow-automation", "backend-development"] },
      { title: "App Developer Intern at Ramyoz Solutions", kind: "experience", didWhat: "shipped AI-enabled Flutter features that consume REST APIs, improving state management and UI performance", skills: ["flutter", "mobile-development", "mobile-api", "rest-apis", "state-management", "performance-optimization"] },
      { title: "RealPath, an AI resume builder and ATS analyzer", kind: "project", didWhat: "built a full-stack platform with Next.js, React, Node.js, Express.js and MongoDB that uses the OpenAI API to compare resumes with job descriptions and suggest improvements", skills: ["nextjs", "react", "typescript", "nodejs", "express", "mongodb", "tailwind", "openai-api", "llm-integration", "ai-resume-analysis", "ai-apps", "reusable-components", "vercel"] },
      { title: "JobSync, a collaborative job-search platform", kind: "project", didWhat: "built group chat, WebRTC audio/video calls, browser push notifications and session-based authentication with HTTP-only cookies in Next.js and TypeScript", skills: ["nextjs", "react", "typescript", "webrtc", "web-push", "google-sheets-api", "authentication", "authorization", "http-only-cookies", "access-control", "vercel"] },
      { title: "PathoView, an AI-powered digital pathology platform", kind: "project", didWhat: "connected a React frontend to Python/FastAPI services that run computer-vision inference and return structured analysis results", skills: ["python", "fastapi", "react", "rest-apis", "computer-vision", "deep-learning", "ai-apps"] },
    ],
    achievements: ["solved 1,150+ problems on CodeChef (3-star, 1650+ rating)"],
    location: "Delhi, India",
  },
  lukky: {
    education: "final-year Computer Science Engineering student specializing in Artificial Intelligence and Data Science",
    skills: ["javascript", "react", "nodejs", "express", "mongodb", "python", "rest-apis", "llm-integration", "rag"],
    highlights: [
      { title: "projects involving MERN stack development and AI integrations", kind: "project", didWhat: "worked with React, Node.js, Express.js and MongoDB and added AI features, including Retrieval-Augmented Generation (RAG) pipelines", skills: ["react", "nodejs", "express", "mongodb", "rest-apis", "llm-integration", "rag"] },
    ],
    achievements: [],
    location: "",
  },
  rishii: {
    education: "",
    skills: [],
    highlights: [],
    achievements: [],
    location: "",
  },
};
