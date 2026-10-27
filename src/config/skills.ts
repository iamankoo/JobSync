/**
 * The approved skill taxonomy for Network Finder email drafts (data, not prose). An email may only ever mention a
 * skill that is in this list AND in the drafting member's own verified profile (config/member-email-profiles.ts);
 * the list itself never adds a claim to anyone's email.
 *
 * Duplicates from the original 200-item brief are merged (React/React.js, RAG/Retrieval-Augmented Generation,
 * Firebase, JWT, Authorization, Technical Documentation, Statistics, Prompt Engineering/Design, Web/Data Scraping,
 * Browser/Web Automation); 15 genuine adjacent skills were added so there are exactly 200 unique skills.
 */
export const TEMPLATE_IDS = ["full-stack", "frontend", "backend", "software", "ai-ml", "data-analyst", "data-engineer", "llm", "automation", "mobile"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type SkillCategory =
  | "language" | "frontend" | "backend" | "database" | "ai" | "data" | "automation" | "devops" | "engineering" | "tools" | "mobile" | "security" | "professional";

export interface Skill {
  id: string;
  name: string;
  category: SkillCategory;
  /** Other spellings that count as the same skill (matching is case-insensitive, whole words). */
  aliases: readonly string[];
  /** Templates this skill is most relevant to. */
  roles: readonly TemplateId[];
  /** 1 (highest) – 3: preference when several skills fit equally. */
  priority: 1 | 2 | 3;
}

/** Categories that name concrete technologies: mentioning one in an email is a claim that must be verified. */
export const TECH_CATEGORIES: readonly SkillCategory[] = ["language", "frontend", "backend", "database", "ai", "data", "automation", "devops", "mobile", "security"];

const R = (...r: TemplateId[]) => r;
const s = (id: string, name: string, category: SkillCategory, roles: TemplateId[], priority: 1 | 2 | 3, aliases: string[] = []): Skill => ({ id, name, category, roles, priority, aliases });

const ALL_ENG = R("full-stack", "frontend", "backend", "software");
const AI = R("ai-ml", "llm");
const DATA = R("data-analyst", "data-engineer");

export const SKILLS: readonly Skill[] = [
  // A. Programming languages
  s("python", "Python", "language", R("ai-ml", "llm", "data-analyst", "data-engineer", "automation", "backend", "software"), 1),
  s("javascript", "JavaScript", "language", R("full-stack", "frontend", "backend", "software"), 1),
  s("typescript", "TypeScript", "language", R("full-stack", "frontend", "backend", "software"), 1),
  s("c", "C", "language", R("software"), 3),
  s("cpp", "C++", "language", R("software"), 2),
  s("sql", "SQL", "language", R("data-analyst", "data-engineer", "backend", "software"), 1),
  s("dart", "Dart", "language", R("mobile"), 1),
  // B. Frontend
  s("react", "React", "frontend", R("full-stack", "frontend"), 1, ["React.js", "ReactJS"]),
  s("nextjs", "Next.js", "frontend", R("full-stack", "frontend"), 1, ["NextJS"]),
  s("redux", "Redux Toolkit", "frontend", R("frontend", "full-stack"), 2, ["Redux"]),
  s("html", "HTML5", "frontend", R("frontend", "full-stack"), 2, ["HTML"]),
  s("css", "CSS3", "frontend", R("frontend", "full-stack"), 2, ["CSS"]),
  s("tailwind", "Tailwind CSS", "frontend", R("frontend", "full-stack"), 2, ["Tailwind"]),
  s("bootstrap", "Bootstrap", "frontend", R("frontend"), 3),
  s("responsive", "Responsive Web Design", "frontend", R("frontend", "full-stack"), 1, ["responsive design", "responsive web applications"]),
  s("component-architecture", "Component Architecture", "frontend", R("frontend", "full-stack"), 2, ["reusable UI components"]),
  s("ui-development", "UI Development", "frontend", R("frontend", "mobile"), 2),
  s("frontend-performance", "Frontend Performance", "frontend", R("frontend"), 2, ["page-load performance"]),
  s("state-management", "State Management", "frontend", R("frontend", "mobile"), 2),
  // C. Backend
  s("nodejs", "Node.js", "backend", R("full-stack", "backend"), 1, ["NodeJS"]),
  s("express", "Express.js", "backend", R("full-stack", "backend"), 1, ["ExpressJS"]),
  s("fastapi", "FastAPI", "backend", R("backend", "ai-ml", "automation"), 1),
  s("rest-apis", "REST APIs", "backend", R("full-stack", "backend", "software", "mobile"), 1, ["REST API", "RESTful APIs"]),
  s("api-integration", "API Integration", "backend", R("full-stack", "backend", "automation", "mobile"), 1),
  s("websockets", "WebSockets", "backend", R("backend", "full-stack"), 2, ["WebSocket"]),
  s("webrtc", "WebRTC", "backend", R("full-stack"), 3),
  s("jwt", "JWT Authentication", "security", R("backend", "full-stack"), 2, ["JWT"]),
  s("webhooks", "Webhooks", "backend", R("backend"), 2, ["Webhook"]),
  s("backend-development", "Backend Development", "backend", R("backend", "full-stack"), 2),
  s("api-design", "API Design", "backend", R("backend"), 2),
  s("server-side", "Server-side Development", "backend", R("backend"), 3),
  s("authentication", "Authentication", "security", R("backend", "full-stack"), 2),
  s("authorization", "Authorization", "security", R("backend", "full-stack"), 2),
  s("session-management", "Session Management", "security", R("backend", "full-stack"), 3),
  // D. Databases & storage
  s("mongodb", "MongoDB", "database", R("full-stack", "backend", "data-engineer"), 1, ["Mongo"]),
  s("postgresql", "PostgreSQL", "database", R("backend", "full-stack", "data-engineer"), 1, ["Postgres"]),
  s("mysql", "MySQL", "database", R("backend", "data-engineer"), 2),
  s("sqlite", "SQLite", "database", R("data-engineer", "automation"), 3),
  s("redis", "Redis", "database", R("backend"), 2),
  s("firebase", "Firebase", "database", R("mobile", "full-stack"), 2),
  s("supabase", "Supabase", "database", R("full-stack", "backend"), 3),
  s("database-design", "Database Design", "database", R("backend", "data-engineer"), 2),
  s("data-modeling", "Data Modeling", "database", R("data-engineer", "backend"), 2),
  s("sql-queries", "SQL Queries", "database", R("data-analyst", "data-engineer"), 2),
  s("database-optimization", "Database Optimization", "database", R("backend", "data-engineer"), 3),
  s("crud", "CRUD Operations", "database", R("backend", "full-stack"), 3, ["CRUD"]),
  s("relational-databases", "Relational Databases", "database", R("backend", "data-engineer"), 3),
  s("nosql", "NoSQL Databases", "database", R("backend", "data-engineer"), 3, ["NoSQL"]),
  s("data-persistence", "Data Persistence", "database", R("backend"), 3),
  // E. AI / ML / LLM
  s("openai-api", "OpenAI API", "ai", AI, 1, ["OpenAI"]),
  s("gemini-api", "Gemini API", "ai", AI, 1, ["Gemini"]),
  s("llms", "Large Language Models", "ai", R("llm", "ai-ml"), 1, ["LLMs", "LLM"]),
  s("generative-ai", "Generative AI", "ai", R("llm", "ai-ml"), 2, ["GenAI", "Gen AI"]),
  s("prompt-engineering", "Prompt Engineering", "ai", AI, 1, ["prompt design", "prompt/context engineering"]),
  s("llm-integration", "LLM Integration", "ai", R("llm", "ai-ml", "full-stack"), 1, ["AI integration", "integrating AI"]),
  s("rag", "Retrieval-Augmented Generation (RAG)", "ai", AI, 1, ["RAG", "Retrieval-Augmented Generation"]),
  s("langchain", "LangChain", "ai", AI, 1),
  s("langgraph", "LangGraph", "ai", AI, 1),
  s("mcp", "MCP Servers", "ai", AI, 2, ["MCP", "Model Context Protocol"]),
  s("ai-agents", "AI Agents", "ai", AI, 1, ["AI agent", "agentic workflows"]),
  s("embeddings", "Embeddings", "ai", AI, 1),
  s("vector-search", "Vector Search", "ai", AI, 2, ["vector database", "vector databases"]),
  s("semantic-search", "Semantic Search", "ai", AI, 2),
  s("chunking", "Chunking", "ai", R("llm"), 2),
  s("indexing", "Indexing", "ai", R("llm", "data-engineer"), 2),
  s("retrieval-pipelines", "Retrieval Pipelines", "ai", R("llm", "ai-ml"), 1),
  s("context-engineering", "Context Engineering", "ai", R("llm"), 2),
  s("ai-workflow-automation", "AI Workflow Automation", "ai", R("ai-ml", "llm", "automation"), 2),
  s("llm-evaluation", "LLM Evaluation", "ai", R("llm"), 3),
  s("ai-output-validation", "AI Output Validation", "ai", R("llm"), 3),
  s("ai-apps", "AI-powered Applications", "ai", R("ai-ml", "llm", "full-stack"), 2),
  s("ai-resume-analysis", "AI Resume Analysis", "ai", R("ai-ml", "llm"), 3, ["ATS analysis", "resume analysis"]),
  s("skill-gap-analysis", "Skill Gap Analysis", "ai", R("ai-ml"), 3),
  s("nlp", "NLP", "ai", R("ai-ml"), 2, ["Natural Language Processing"]),
  s("spacy", "spaCy", "ai", R("ai-ml"), 2),
  s("nltk", "NLTK", "ai", R("ai-ml"), 2),
  s("scikit-learn", "scikit-learn", "ai", R("ai-ml", "data-analyst"), 1, ["sklearn"]),
  s("machine-learning", "Machine Learning", "ai", R("ai-ml"), 1),
  s("deep-learning", "Deep Learning", "ai", R("ai-ml"), 2),
  s("computer-vision", "Computer Vision", "ai", R("ai-ml"), 2),
  // F. Data & analytics
  s("pandas", "Pandas", "data", DATA, 1),
  s("numpy", "NumPy", "data", R("data-analyst", "data-engineer", "ai-ml"), 1),
  s("data-analysis", "Data Analysis", "data", R("data-analyst"), 1),
  s("data-cleaning", "Data Cleaning", "data", DATA, 1),
  s("data-validation", "Data Validation", "data", DATA, 1),
  s("data-processing", "Data Processing", "data", DATA, 2),
  s("data-extraction", "Data Extraction", "data", R("data-engineer", "automation"), 2),
  s("data-transformation", "Data Transformation", "data", R("data-engineer"), 2),
  s("data-visualization", "Data Visualization", "data", R("data-analyst"), 1),
  s("data-reporting", "Data Reporting", "data", R("data-analyst"), 2),
  s("business-intelligence", "Business Intelligence", "data", R("data-analyst"), 3, ["BI"]),
  s("power-bi", "Power BI", "data", R("data-analyst"), 1),
  s("excel", "Microsoft Excel", "data", R("data-analyst"), 2, ["Excel", "Advanced Excel"]),
  s("statistics", "Statistical Analysis", "data", R("data-analyst", "ai-ml"), 2, ["Statistics"]),
  s("probability", "Probability", "data", R("data-analyst", "ai-ml"), 3),
  s("etl", "ETL", "data", R("data-engineer"), 1),
  s("data-pipelines", "Data Pipelines", "data", R("data-engineer", "ai-ml"), 1, ["data pipeline"]),
  s("data-quality", "Data Quality", "data", R("data-engineer"), 2),
  s("business-analytics", "Business Analytics", "data", R("data-analyst"), 3),
  // G. Automation / scraping
  s("playwright", "Playwright", "automation", R("automation"), 1),
  s("selenium", "Selenium", "automation", R("automation"), 1),
  s("asyncio", "Asyncio", "automation", R("automation"), 2),
  s("browser-automation", "Browser Automation", "automation", R("automation"), 1, ["web automation"]),
  s("workflow-automation", "Workflow Automation", "automation", R("automation"), 1, ["process automation", "task automation"]),
  s("web-scraping", "Web Scraping", "automation", R("automation", "data-engineer"), 1, ["data scraping", "automated data collection"]),
  s("ocr", "OCR", "automation", R("automation"), 2, ["text extraction"]),
  s("form-automation", "Form Automation", "automation", R("automation"), 3, ["intelligent form filling"]),
  s("automated-reporting", "Automated Reporting", "automation", R("automation", "data-analyst"), 2),
  s("data-parsing", "Data Parsing", "automation", R("automation", "data-engineer"), 3),
  s("deduplication", "Deduplication", "automation", R("automation", "data-engineer"), 3),
  s("automated-qa", "Automated QA", "automation", R("automation", "software"), 3),
  // H. Cloud / DevOps / deployment
  s("git", "Git", "devops", ALL_ENG, 2),
  s("github", "GitHub", "devops", ALL_ENG, 3),
  s("gitlab", "GitLab", "devops", R("software"), 3),
  s("docker", "Docker", "devops", R("backend", "software", "data-engineer"), 2),
  s("ci-cd", "CI/CD", "devops", R("backend", "software"), 2, ["CI CD"]),
  s("github-actions", "GitHub Actions", "devops", R("software", "backend"), 3),
  s("vercel", "Vercel", "devops", R("full-stack", "frontend"), 3),
  s("render", "Render", "devops", R("backend"), 3),
  s("aws", "AWS", "devops", R("backend", "software", "data-engineer"), 2, ["Amazon Web Services"]),
  s("cloud-deployment", "Cloud Deployment", "devops", R("backend", "full-stack"), 2, ["production deployment"]),
  s("environment-config", "Environment Configuration", "devops", R("backend"), 3, ["environment variables"]),
  s("deployment-automation", "Deployment Automation", "devops", R("software"), 3),
  s("version-control", "Version Control", "devops", ALL_ENG, 3),
  s("build-pipelines", "Build Pipelines", "devops", R("software"), 3),
  s("monitoring", "Application Monitoring", "devops", R("backend"), 3),
  // I. Software engineering
  s("oop", "Object-Oriented Programming", "engineering", R("software", "backend"), 2, ["OOP"]),
  s("data-structures", "Data Structures", "engineering", R("software"), 1, ["DSA"]),
  s("algorithms", "Algorithms", "engineering", R("software"), 1),
  s("debugging", "Debugging", "engineering", ALL_ENG, 2),
  s("unit-testing", "Unit Testing", "engineering", ALL_ENG, 2),
  s("integration-testing", "Integration Testing", "engineering", R("software", "backend"), 2),
  s("e2e-testing", "End-to-End Testing", "engineering", R("software", "frontend"), 3),
  s("tdd", "Test-Driven Development", "engineering", R("software"), 3, ["TDD"]),
  s("code-review", "Code Review", "engineering", ALL_ENG, 2),
  s("agile", "Agile Development", "engineering", ALL_ENG, 2, ["Agile"]),
  s("jira", "Jira", "tools", ALL_ENG, 3),
  s("software-architecture", "Software Architecture", "engineering", R("software", "backend"), 3),
  s("modular-architecture", "Modular Architecture", "engineering", R("software"), 3),
  s("reusable-components", "Reusable Components", "engineering", R("frontend", "full-stack"), 2),
  s("clean-code", "Clean Code", "engineering", R("software"), 3),
  s("error-handling", "Error Handling", "engineering", R("backend", "software"), 3),
  s("performance-optimization", "Performance Optimization", "engineering", R("software", "frontend", "mobile"), 2),
  s("scalability", "Scalability", "engineering", R("backend"), 3),
  s("maintainability", "Maintainability", "engineering", R("software"), 3),
  s("api-testing", "API Testing", "engineering", R("backend"), 3),
  s("competitive-programming", "Competitive Programming", "engineering", R("software"), 2),
  s("distributed-systems", "Distributed Systems", "engineering", R("backend", "software"), 3),
  s("information-retrieval", "Information Retrieval", "engineering", R("llm", "data-engineer"), 3),
  // J. Tools / workflow
  s("postman", "Postman", "tools", R("backend"), 3),
  s("google-workspace", "Google Workspace", "tools", R("data-analyst"), 3),
  s("ms-office", "Microsoft Office", "tools", R("data-analyst"), 3),
  s("vscode", "VS Code", "tools", ALL_ENG, 3),
  s("git-workflows", "Git Workflows", "tools", ALL_ENG, 3, ["branch management"]),
  s("api-documentation", "API Documentation", "tools", R("backend"), 2, ["documented REST APIs"]),
  s("technical-documentation", "Technical Documentation", "tools", ALL_ENG, 3),
  s("requirement-analysis", "Requirement Analysis", "tools", R("software"), 3, ["requirements gathering"]),
  s("stakeholder-collaboration", "Stakeholder Collaboration", "tools", R("software"), 3),
  s("ui-ux-collaboration", "UI/UX Collaboration", "tools", R("frontend"), 3),
  s("google-sheets-api", "Google Sheets API", "backend", R("full-stack", "automation"), 3),
  s("web-push", "Web Push Notifications", "frontend", R("full-stack", "frontend"), 3, ["Push API", "service workers"]),
  // K. Mobile
  s("flutter", "Flutter", "mobile", R("mobile"), 1),
  s("flutter-ui", "Flutter UI", "mobile", R("mobile"), 2),
  s("mobile-development", "Mobile Application Development", "mobile", R("mobile"), 1, ["mobile app development"]),
  s("cross-platform", "Cross-platform Development", "mobile", R("mobile"), 2),
  s("mobile-state", "Mobile State Management", "mobile", R("mobile"), 2),
  s("mobile-api", "Mobile API Integration", "mobile", R("mobile"), 2),
  s("mobile-performance", "Mobile Performance", "mobile", R("mobile"), 2),
  s("qr-scanning", "QR Code Scanning", "mobile", R("mobile"), 3),
  s("firebase-mobile", "Firebase Mobile Integration", "mobile", R("mobile"), 3),
  // L. Security / web
  s("authentication-security", "Authentication Security", "security", R("backend"), 3),
  s("http-only-cookies", "HTTP-only Cookies", "security", R("backend", "full-stack"), 3),
  s("session-security", "Session Security", "security", R("backend"), 3),
  s("api-security", "API Security", "security", R("backend"), 3),
  s("secure-uploads", "Secure File Uploads", "security", R("backend"), 3),
  s("input-validation", "Input Validation", "security", R("backend", "full-stack"), 3),
  s("access-control", "Access Control", "security", R("backend"), 3, ["member-level authorization", "role-based access"]),
  // N. Adjacent skills JobSync's target roles commonly ask for (taxonomy only — never claimed unless verified).
  s("pytorch", "PyTorch", "ai", R("ai-ml"), 2),
  s("tensorflow", "TensorFlow", "ai", R("ai-ml"), 2),
  s("hugging-face", "Hugging Face", "ai", R("llm", "ai-ml"), 2, ["Hugging Face Transformers"]),
  s("matplotlib", "Matplotlib", "data", R("data-analyst"), 3),
  s("tableau", "Tableau", "data", R("data-analyst"), 2),
  s("airflow", "Apache Airflow", "data", R("data-engineer"), 2, ["Airflow"]),
  s("jupyter", "Jupyter Notebook", "tools", R("data-analyst", "ai-ml"), 3, ["Jupyter"]),
  s("graphql", "GraphQL", "backend", R("backend", "full-stack"), 2),
  s("jest", "Jest", "engineering", R("frontend", "full-stack", "software"), 2),
  s("prisma", "Prisma", "database", R("backend", "full-stack"), 3),
  s("mongoose", "Mongoose", "database", R("backend", "full-stack"), 3),
  s("socketio", "Socket.IO", "backend", R("backend", "full-stack"), 3),
  s("linux", "Linux", "devops", R("backend", "software", "automation"), 2),
  s("shell-scripting", "Shell Scripting", "devops", R("automation", "software"), 2, ["Bash"]),
  s("kubernetes", "Kubernetes", "devops", R("backend", "software"), 3),
  // M. Communication / professional
  s("technical-communication", "Technical Communication", "professional", ALL_ENG, 3),
  s("problem-solving", "Problem Solving", "professional", R("software"), 2),
  s("analytical-thinking", "Analytical Thinking", "professional", R("data-analyst"), 2),
  s("attention-to-detail", "Attention to Detail", "professional", R("data-analyst"), 3),
  s("team-collaboration", "Team Collaboration", "professional", ALL_ENG, 3),
  s("stakeholder-communication", "Stakeholder Communication", "professional", R("software"), 3),
  s("independent-development", "Independent Development", "professional", R("software"), 3),
  s("product-thinking", "Product Thinking", "professional", R("full-stack"), 3),
];

const BY_ID = new Map(SKILLS.map((k) => [k.id, k]));
export const getSkill = (id: string): Skill | undefined => BY_ID.get(id);
