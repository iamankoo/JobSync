import type { TemplateId } from "./skills";

/**
 * The 10 role templates for Network Finder email drafts. A template is STRUCTURE and EMPHASIS (what to stress, in
 * what order, which skills first) — never text copied verbatim. The composer fills it only with verified facts
 * (config/member-email-profiles.ts) and the real company/contact/job; Nemotron writes within it.
 *
 * Placeholders a template's sentences may use: {{company}}, {{role}}, {{areas}}, {{capabilities}}.
 * Bump `version` when a template's wording changes (recorded with each draft for traceability).
 */
export interface EmailTemplate {
  id: TemplateId;
  version: number;
  /** Used in the subject and opening when no specific job title is known, e.g. "Full Stack Developer". */
  roleLabel: string;
  /** Lower-case words/phrases in a job title or description that select this template (whole-word match). */
  keywords: readonly string[];
  /** Skill ids to prefer, most important first (only those the member really has are used). */
  prioritySkills: readonly string[];
  /** 2–4 areas for "…with hands-on experience in {{areas}}" (chosen from these, if the member has matching skills). */
  areas: readonly { text: string; skills: readonly string[] }[];
  /** Two abilities for "…strengthened my ability to {{capabilities}}". */
  capabilities: readonly string[];
  /** Role-specific value sentence (no claims beyond the member's facts). */
  valueProposition: string;
  /** Neutral, honest sentence used when nothing verified is known about the company. */
  neutralMotivation: string;
  /** What the member would contribute to, e.g. "your product engineering". */
  contributeTo: string;
  /** Guidance for Nemotron: the angle of this role. */
  guidance: string;
}

export const EMAIL_TEMPLATES: readonly EmailTemplate[] = [
  {
    id: "full-stack", version: 1, roleLabel: "Full Stack Developer",
    keywords: ["full stack", "full-stack", "fullstack", "mern", "mean stack", "web developer", "web engineer"],
    prioritySkills: ["react", "nextjs", "typescript", "nodejs", "express", "rest-apis", "mongodb", "postgresql", "authentication", "responsive", "cloud-deployment", "vercel"],
    areas: [
      { text: "building end-to-end web applications", skills: ["react", "nodejs", "nextjs"] },
      { text: "REST API development and integration", skills: ["rest-apis", "api-integration"] },
      { text: "database-backed applications", skills: ["mongodb", "postgresql", "mysql"] },
      { text: "deploying production apps", skills: ["vercel", "cloud-deployment", "docker"] },
    ],
    capabilities: ["own features from the database to the UI", "ship maintainable code that works in production"],
    valueProposition: "I am comfortable moving between the frontend and the backend, which helps me deliver complete features rather than isolated pieces.",
    neutralMotivation: "the chance to work on a product end to end, from the interface to the APIs and data behind it",
    contributeTo: "your product engineering work",
    guidance: "End-to-end ownership: frontend + backend + data + deployment. Mention one project that spans the stack.",
  },
  {
    id: "frontend", version: 1, roleLabel: "Frontend Developer",
    keywords: ["frontend", "front-end", "front end", "react developer", "react engineer", "ui engineer", "ui developer", "next.js developer"],
    prioritySkills: ["react", "nextjs", "typescript", "javascript", "redux", "html", "css", "tailwind", "responsive", "component-architecture", "frontend-performance", "state-management"],
    areas: [
      { text: "responsive interfaces in React and Next.js", skills: ["react", "nextjs", "responsive"] },
      { text: "reusable component architecture", skills: ["component-architecture", "reusable-components"] },
      { text: "state management", skills: ["redux", "state-management"] },
      { text: "frontend performance", skills: ["frontend-performance", "performance-optimization"] },
    ],
    capabilities: ["turn designs into accessible, responsive interfaces", "keep a growing UI fast and consistent"],
    valueProposition: "I care about how an interface feels to use, and I pay attention to responsiveness, loading speed and consistent components.",
    neutralMotivation: "the focus on building interfaces that people use every day",
    contributeTo: "your frontend and user experience",
    guidance: "User-facing quality: components, responsiveness, performance, clean UI integration with APIs.",
  },
  {
    id: "backend", version: 1, roleLabel: "Backend Developer",
    keywords: ["backend", "back-end", "back end", "node.js developer", "node developer", "api engineer", "api developer", "server-side"],
    prioritySkills: ["nodejs", "express", "fastapi", "rest-apis", "postgresql", "mongodb", "redis", "jwt", "authentication", "webhooks", "api-integration", "api-documentation"],
    areas: [
      { text: "REST APIs with Node.js and FastAPI", skills: ["nodejs", "express", "fastapi", "rest-apis"] },
      { text: "database-backed services", skills: ["mongodb", "postgresql", "mysql", "sql"] },
      { text: "authentication and access control", skills: ["jwt", "authentication", "access-control"] },
      { text: "third-party API and webhook integrations", skills: ["api-integration", "webhooks"] },
    ],
    capabilities: ["design clear, well-documented APIs", "handle data and authentication safely on the server"],
    valueProposition: "I like the server side of products — clean APIs, sensible data models and reliable error handling.",
    neutralMotivation: "the chance to work on the services and APIs that a product depends on",
    contributeTo: "your backend services",
    guidance: "APIs, data models, auth, integrations, reliability. Avoid frontend detail unless relevant.",
  },
  {
    id: "software", version: 1, roleLabel: "Software Engineer",
    keywords: ["software engineer", "software developer", "software engineering", "sde", "swe", "engineering intern", "software intern", "developer intern", "member of technical staff", "programmer"],
    prioritySkills: ["data-structures", "algorithms", "typescript", "python", "javascript", "react", "nodejs", "rest-apis", "oop", "unit-testing", "git", "debugging"],
    areas: [
      { text: "data structures and algorithms", skills: ["data-structures", "algorithms", "competitive-programming"] },
      { text: "full-stack web development", skills: ["react", "nodejs", "rest-apis"] },
      { text: "testing and debugging", skills: ["unit-testing", "integration-testing", "debugging"] },
      { text: "collaborative development with code reviews", skills: ["code-review", "git", "agile"] },
    ],
    capabilities: ["break problems down and solve them carefully", "contribute to an existing codebase as part of a team"],
    valueProposition: "I learn new codebases quickly and enjoy turning a vague problem into working, tested software.",
    neutralMotivation: "the opportunity to grow as an engineer while contributing to real products",
    contributeTo: "your engineering team",
    guidance: "General engineering: fundamentals, problem solving, shipping, teamwork. Broad but specific to the member.",
  },
  {
    id: "ai-ml", version: 1, roleLabel: "AI/ML Engineer",
    keywords: ["ai/ml", "ai ml", "machine learning", "ml engineer", "ml intern", "ai intern", "artificial intelligence", "deep learning", "computer vision", "nlp", "data scientist", "data science"],
    prioritySkills: ["python", "machine-learning", "scikit-learn", "openai-api", "gemini-api", "rag", "embeddings", "prompt-engineering", "ai-agents", "langchain", "langgraph", "mcp", "computer-vision", "data-pipelines"],
    areas: [
      { text: "integrating AI models into applications", skills: ["openai-api", "gemini-api", "llm-integration", "ai-apps"] },
      { text: "retrieval pipelines and embeddings", skills: ["rag", "embeddings", "retrieval-pipelines"] },
      { text: "Python services for AI workflows", skills: ["python", "fastapi"] },
      { text: "computer vision and deep learning", skills: ["computer-vision", "deep-learning"] },
    ],
    capabilities: ["turn AI capabilities into features people can use", "build the data and API plumbing around a model"],
    valueProposition: "My focus is practical: getting AI to work reliably inside a real product, not just in a notebook.",
    neutralMotivation: "the chance to apply AI to practical problems",
    contributeTo: "your AI and ML work",
    guidance: "Practical applied AI: models in products, data pipelines, evaluation of outputs. No research claims.",
  },
  {
    id: "data-analyst", version: 1, roleLabel: "Data Analyst",
    keywords: ["data analyst", "business analyst", "analytics", "bi analyst", "bi developer", "business intelligence", "reporting analyst", "product analyst"],
    prioritySkills: ["python", "sql", "pandas", "numpy", "data-cleaning", "data-validation", "power-bi", "excel", "data-visualization", "data-reporting", "statistics", "data-analysis"],
    areas: [
      { text: "data cleaning and validation", skills: ["data-cleaning", "data-validation", "pandas"] },
      { text: "SQL querying", skills: ["sql", "sql-queries"] },
      { text: "dashboards and reporting", skills: ["power-bi", "data-visualization", "data-reporting", "automated-reporting"] },
      { text: "working with Python for analysis", skills: ["python", "pandas", "numpy"] },
    ],
    capabilities: ["turn raw data into clear, decision-ready insights", "check data carefully before drawing conclusions"],
    valueProposition: "I enjoy finding the story in data and presenting it in a way that helps a team make decisions.",
    neutralMotivation: "the chance to help a team make decisions with data",
    contributeTo: "your analytics and reporting",
    guidance: "Insight and accuracy: SQL, Python, cleaning, dashboards, clear communication of findings.",
  },
  {
    id: "data-engineer", version: 1, roleLabel: "Data Engineer",
    keywords: ["data engineer", "data engineering", "etl", "analytics engineer", "data platform", "data pipeline", "pipelines"],
    prioritySkills: ["python", "sql", "etl", "data-pipelines", "data-validation", "postgresql", "mongodb", "sqlite", "workflow-automation", "api-integration", "data-transformation", "indexing"],
    areas: [
      { text: "data pipelines and ETL", skills: ["etl", "data-pipelines", "data-transformation"] },
      { text: "working with production databases", skills: ["postgresql", "mysql", "mongodb", "sql"] },
      { text: "API-based data integration", skills: ["api-integration", "rest-apis"] },
      { text: "automating data workflows in Python", skills: ["python", "workflow-automation", "automated-reporting"] },
    ],
    capabilities: ["move data reliably between systems", "keep pipelines correct as data changes"],
    valueProposition: "I like building the dependable plumbing that other teams rely on for clean, timely data.",
    neutralMotivation: "the chance to work on the data foundations a product depends on",
    contributeTo: "your data infrastructure",
    guidance: "Reliable data movement: pipelines, validation, databases, automation, structured/unstructured data.",
  },
  {
    id: "llm", version: 1, roleLabel: "AI Engineer (LLM)",
    keywords: ["llm", "large language model", "generative ai", "genai", "gen ai", "rag", "prompt engineer", "ai engineer", "applied ai", "ai application", "langchain", "agents", "agentic"],
    prioritySkills: ["openai-api", "gemini-api", "prompt-engineering", "langchain", "langgraph", "rag", "ai-agents", "mcp", "embeddings", "retrieval-pipelines", "chunking", "indexing", "llm-integration", "context-engineering"],
    areas: [
      { text: "retrieval-augmented generation", skills: ["rag", "retrieval-pipelines", "embeddings", "chunking", "indexing"] },
      { text: "LLM integration with the OpenAI and Gemini APIs", skills: ["openai-api", "gemini-api", "llm-integration"] },
      { text: "prompt and context engineering", skills: ["prompt-engineering", "context-engineering"] },
      { text: "agent workflows with LangChain and LangGraph", skills: ["langchain", "langgraph", "ai-agents", "mcp"] },
    ],
    capabilities: ["ground LLM output in the right context", "build LLM features that stay reliable in production"],
    valueProposition: "I have spent time on the less glamorous parts of LLM work — retrieval quality, prompts and validating outputs — which is what makes these features dependable.",
    neutralMotivation: "the chance to build practical applications on top of large language models",
    contributeTo: "your LLM and AI application work",
    guidance: "Applied LLM engineering: RAG, prompts, agents, grounding, reliability. Implementation over theory.",
  },
  {
    id: "automation", version: 1, roleLabel: "Python / Automation Engineer",
    keywords: ["automation", "python developer", "python engineer", "scraping", "web scraping", "rpa", "qa automation", "test automation", "playwright", "selenium", "scripting"],
    prioritySkills: ["python", "playwright", "selenium", "asyncio", "browser-automation", "workflow-automation", "web-scraping", "api-integration", "ocr", "data-extraction", "fastapi", "automated-reporting"],
    areas: [
      { text: "workflow automation in Python", skills: ["python", "workflow-automation", "automated-reporting", "ai-workflow-automation"] },
      { text: "browser automation and scraping", skills: ["playwright", "selenium", "browser-automation", "web-scraping"] },
      { text: "API integrations", skills: ["api-integration", "rest-apis", "fastapi"] },
      { text: "data extraction", skills: ["data-extraction", "ocr", "data-parsing"] },
    ],
    capabilities: ["remove repetitive manual work", "build scripts and services that run reliably unattended"],
    valueProposition: "I like finding repetitive manual work and replacing it with reliable automation.",
    neutralMotivation: "the chance to automate work that currently takes people time",
    contributeTo: "your automation and tooling",
    guidance: "Automation and Python: removing manual effort, reliability, integrations. Quantify only with verified facts.",
  },
  {
    id: "mobile", version: 1, roleLabel: "Mobile / Flutter Developer",
    keywords: ["flutter", "mobile", "android", "ios", "dart", "react native", "app developer", "mobile developer"],
    prioritySkills: ["flutter", "dart", "mobile-development", "rest-apis", "firebase", "state-management", "mobile-api", "ui-development", "performance-optimization", "cross-platform"],
    areas: [
      { text: "Flutter app development", skills: ["flutter", "flutter-ui", "mobile-development"] },
      { text: "consuming REST APIs in mobile apps", skills: ["rest-apis", "mobile-api"] },
      { text: "state management and UI performance", skills: ["state-management", "performance-optimization"] },
      { text: "Firebase integration", skills: ["firebase", "firebase-mobile"] },
    ],
    capabilities: ["build smooth, responsive mobile screens", "connect mobile apps cleanly to backend APIs"],
    valueProposition: "I enjoy mobile work because small details in performance and state handling make a visible difference to users.",
    neutralMotivation: "the chance to build mobile experiences people use daily",
    contributeTo: "your mobile app",
    guidance: "Mobile quality: Flutter, API integration, state management, performance.",
  },
];

/** When nothing in the title/description points elsewhere. */
export const DEFAULT_TEMPLATE: TemplateId = "software";
export const TEMPLATES_BY_ID = new Map(EMAIL_TEMPLATES.map((t) => [t.id, t]));
