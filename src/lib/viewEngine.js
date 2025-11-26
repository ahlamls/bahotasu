import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Mustache from "mustache";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewsRoot = path.join(__dirname, "..", "views");
const templateCache = new Map();
const partialsCache = new Map();

const readTemplateFile = (relativePath) => {
  const cacheKey = relativePath;
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey);
  }
  const fullPath = path.join(viewsRoot, `${relativePath}.mustache`);
  const contents = fs.readFileSync(fullPath, "utf8");
  templateCache.set(cacheKey, contents);
  return contents;
};

const loadPartials = () => {
  if (partialsCache.size > 0) {
    return Object.fromEntries(partialsCache);
  }

  const partialsDir = path.join(viewsRoot, "partials");
  if (!fs.existsSync(partialsDir)) {
    return {};
  }

  const files = fs
    .readdirSync(partialsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mustache"));

  files.forEach((file) => {
    const name = path.basename(file.name, ".mustache");
    const fullPath = path.join(partialsDir, file.name);
    partialsCache.set(name, fs.readFileSync(fullPath, "utf8"));
  });

  return Object.fromEntries(partialsCache);
};

export const renderPage = (templateName, data = {}, { layout = "layouts/base" } = {}) => {
  const partials = loadPartials();
  const body = Mustache.render(readTemplateFile(templateName), data, partials);
  return Mustache.render(
    readTemplateFile(layout),
    { ...data, body },
    partials,
  );
};

