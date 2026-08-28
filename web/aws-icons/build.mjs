// Generates src/assets/aws-icons.json from the AWS Architecture Icons asset
// package (https://aws.amazon.com/architecture/icons/) and catalog.json.
//
//   node aws-icons/build.mjs <Asset-Package_MMDDYYYY.zip | extracted directory>
//
// Services, groups and general icons need a catalog entry each (the script
// fails listing what is missing or stale). Resource icons derive name, label
// and a default description from their file name; catalog.resources holds
// optional per-slug overrides for the ones whose names need help.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const OUTPUT = resolve(here, "../src/assets/aws-icons.json");
const PACK_ID = "aws-architecture-icons";
const COLLECTION = "AWS Architecture Icons";

const CATEGORY_NAMES = {
  "Analytics": "Analytics",
  "App-Integration": "Application Integration",
  "Application-Integration": "Application Integration",
  "Artificial-Intelligence": "Artificial Intelligence",
  "Blockchain": "Blockchain",
  "Business-Applications": "Business Applications",
  "Cloud-Financial-Management": "Cloud Financial Management",
  "Compute": "Compute",
  "Containers": "Containers",
  "Customer-Enablement": "Customer Enablement",
  "Database": "Database",
  "Developer-Tools": "Developer Tools",
  "End-User-Computing": "End User Computing",
  "Front-End-Web-Mobile": "Front-End Web & Mobile",
  "Games": "Games",
  "General-Icons": "General",
  "Internet-of-Things": "Internet of Things",
  "IoT": "Internet of Things",
  "Management-Governance": "Management & Governance",
  "Media-Services": "Media Services",
  "Migration-Modernization": "Migration & Modernization",
  "Networking-Content-Delivery": "Networking & Content Delivery",
  "Quantum-Technologies": "Quantum Technologies",
  "Satellite": "Satellite",
  "Security-Identity-Compliance": "Security, Identity & Compliance",
  "Storage": "Storage"
};

// Resource labels lead with the service the way AWS abbreviates it.
const SERVICE_SHORT_NAMES = {
  "Amazon Simple Storage Service": "S3",
  "Amazon Simple Storage Service Glacier": "S3 Glacier",
  "Amazon Elastic Block Store": "EBS",
  "Amazon Elastic Container Service": "ECS",
  "Amazon Elastic Container Registry": "ECR",
  "Amazon Elastic Kubernetes Service": "EKS",
  "Amazon Elastic File System": "EFS",
  "Amazon Simple Queue Service": "SQS",
  "Amazon Simple Notification Service": "SNS",
  "Amazon Simple Email Service": "SES",
  "AWS Identity Access Management": "IAM",
  "AWS Key Management Service": "KMS",
  "AWS Database Migration Service": "DMS",
  "Amazon Virtual Private Cloud": "VPC",
  "Elastic Load Balancing": "ELB",
  "AWS Certificate Manager": "ACM",
  "Amazon WorkSpaces Family": "WorkSpaces",
  "Amazon OpenSearch Service": "OpenSearch",
  "Amazon Location Service": "Location Service",
  "AWS Application Discovery Service": "Application Discovery",
  "AWS Elemental MediaConnect": "MediaConnect",
  "AWS Mainframe Modernization": "Mainframe Modernization",
  "Amazon Managed Blockchain": "Managed Blockchain"
};

const LABEL_MAX_CHARS = 20;

const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const humanize = (value) => value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

const stripVendor = (value) => value.replace(/^(Amazon|AWS)\s+/, "");

const shortService = (service) => SERVICE_SHORT_NAMES[service] ?? stripVendor(service);

// The package ships pretty-printed SVGs with an XML prolog and a <title>;
// neither affects rendering and both inflate the data URLs.
const compactSvg = (svg) =>
  svg
    .replace(/<\?xml[^>]*\?>\s*/, "")
    .replace(/<title>[^<]*<\/title>\s*/, "")
    .replace(/>\s+</g, "><")
    .trim();

// Word wrap for the label under an icon; explicit newlines win. Two balanced
// lines are preferred (up to LABEL_WIDE_CHARS each) before falling back to a
// greedy wrap.
const LABEL_WIDE_CHARS = 24;
const wrapLabel = (label) => {
  if (label.includes("\n") || label.length <= LABEL_MAX_CHARS) {
    return label;
  }
  const middle = label.length / 2;
  let best = -1;
  for (let index = label.indexOf(" "); index !== -1; index = label.indexOf(" ", index + 1)) {
    if (best === -1 || Math.abs(index - middle) < Math.abs(best - middle)) {
      best = index;
    }
  }
  if (best !== -1 && best <= LABEL_WIDE_CHARS && label.length - best - 1 <= LABEL_WIDE_CHARS) {
    return `${label.slice(0, best)}\n${label.slice(best + 1)}`;
  }
  const lines = [];
  let current = "";
  for (const word of label.split(" ")) {
    if (current && `${current} ${word}`.length > LABEL_MAX_CHARS) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.join("\n");
};

const stripParenthetical = (name) => name.replace(/\s*\([^)]*\)\s*$/, "");

const findDirectory = (root, prefix) => {
  const match = readdirSync(root).find(
    (entry) => entry.startsWith(prefix) && statSync(join(root, entry)).isDirectory()
  );
  if (!match) {
    throw new Error(`No "${prefix}*" directory inside ${root}`);
  }
  return join(root, match);
};

const packageVersion = (directory) => {
  const match = basename(directory).match(/_(\d{8})$/);
  if (!match) {
    throw new Error(`Cannot read the package date from "${basename(directory)}"`);
  }
  return match[1];
};

// Package dates are MMDDYYYY.
const versionToEpoch = (version) =>
  Date.UTC(Number(version.slice(4, 8)), Number(version.slice(0, 2)) - 1, Number(version.slice(2, 4)));

// "Res_<Service>_<Resource>_48.svg": the first underscore splits service from
// resource, later ones are spaces. Files without a separator are a resource
// named by the whole string.
const parseResourceName = (raw) => {
  const separator = raw.indexOf("_");
  if (separator === -1) {
    const name = humanize(raw);
    return { service: null, resource: name, name, label: stripVendor(name) };
  }
  const service = humanize(raw.slice(0, separator));
  const resource = humanize(raw.slice(separator + 1));
  const short = shortService(service);
  const vendor = service.match(/^(Amazon|AWS)\b/)?.[1];
  // Resources whose name already carries the service ("AWS Backup ...",
  // "S3 Standard", "OpenSearch Dashboards") are not prefixed again.
  const vendorPrefix = vendor ? `${vendor} ` : "";
  if (resource.startsWith(service)) {
    return { service, resource, name: resource, label: stripVendor(resource) };
  }
  if (resource.startsWith(`${stripVendor(service)} `) || resource.startsWith(`${short} `)) {
    return { service, resource, name: `${vendorPrefix}${resource}`, label: resource };
  }
  return { service, resource, name: `${vendorPrefix}${short} ${resource}`, label: `${short} ${resource}` };
};

const main = () => {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: node aws-icons/build.mjs <Asset-Package.zip | directory>");
    process.exit(2);
  }
  const catalog = JSON.parse(readFileSync(join(here, "catalog.json"), "utf8"));

  let root = resolve(source);
  let scratch = null;
  if (statSync(root).isFile()) {
    scratch = mkdtempSync(join(tmpdir(), "aws-icons-"));
    execFileSync("unzip", ["-q", root, "-d", scratch, "-x", "__MACOSX/*"], { stdio: "inherit" });
    root = scratch;
  }

  try {
    const servicesDir = findDirectory(root, "Architecture-Service-Icons_");
    const groupsDir = findDirectory(root, "Architecture-Group-Icons_");
    const resourcesDir = findDirectory(root, "Resource-Icons_");
    const generalDir = join(resourcesDir, "Res_General-Icons", "Res_48_Light");
    const version = packageVersion(servicesDir);

    const problems = [];
    const items = [];
    const seen = new Set();

    const emit = (kind, slug, folder, meta, svg, extra = {}) => {
      const id = `aws-${kind}-${slug}`;
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      items.push({
        id,
        kind,
        folder: [COLLECTION, ...folder],
        category: folder[folder.length - 1],
        name: meta.name,
        label: wrapLabel(meta.label ?? stripParenthetical(meta.name)),
        description: meta.description,
        ...extra,
        ...(svg ? { svg: compactSvg(svg) } : {})
      });
    };

    const categoryOf = (directoryName, prefix) => {
      const key = directoryName.slice(prefix.length);
      const category = CATEGORY_NAMES[key];
      if (!category) {
        problems.push(`unknown category directory ${directoryName}`);
      }
      return category;
    };

    // Services: Arch_<Category>/64/Arch_<Name>_64.svg. Light/Dark pairs keep
    // the light variant; the same icon under two categories keeps the first.
    const serviceMeta = catalog.services;
    const usedServices = new Set();
    for (const categoryDir of readdirSync(servicesDir).filter((entry) => entry.startsWith("Arch_")).sort()) {
      const category = categoryOf(categoryDir, "Arch_");
      if (!category) {
        continue;
      }
      const iconsDir = join(servicesDir, categoryDir, "64");
      for (const file of readdirSync(iconsDir).filter((entry) => entry.endsWith("_64.svg")).sort()) {
        const raw = file.replace(/^Arch_/, "").replace(/_64\.svg$/, "");
        if (raw.endsWith("_Dark")) {
          continue;
        }
        const slug = slugify(raw.replace(/_Light$/, ""));
        const meta = serviceMeta[slug];
        if (!meta) {
          problems.push(`service icon without catalog entry: ${slug} (${categoryDir}/${file})`);
          continue;
        }
        usedServices.add(slug);
        emit("service", slug, ["Services", category], meta, readFileSync(join(iconsDir, file), "utf8"));
      }
    }
    for (const slug of Object.keys(serviceMeta)) {
      if (!usedServices.has(slug)) {
        problems.push(`catalog service without icon: ${slug}`);
      }
    }

    // Resources: Res_<Category>/Res_<Service>_<Resource>_48.svg (General has
    // its own light/dark layout and is handled below).
    const resourceMeta = catalog.resources ?? {};
    const usedResources = new Set();
    for (const categoryDir of readdirSync(resourcesDir)
      .filter((entry) => entry.startsWith("Res_") && entry !== "Res_General-Icons")
      .sort()) {
      const category = categoryOf(categoryDir, "Res_");
      if (!category) {
        continue;
      }
      const iconsDir = join(resourcesDir, categoryDir);
      for (const file of readdirSync(iconsDir).filter((entry) => entry.endsWith("_48.svg")).sort()) {
        const raw = file.replace(/^Res_/, "").replace(/_48\.svg$/, "").trim();
        const slug = slugify(raw);
        const parsed = parseResourceName(raw);
        const override = resourceMeta[slug] ?? {};
        usedResources.add(slug);
        const name = override.name ?? parsed.name;
        const meta = {
          name,
          label: override.label ?? (override.name ? stripVendor(stripParenthetical(name)) : parsed.label),
          description:
            override.description ??
            (parsed.service
              ? `${parsed.resource} (${parsed.service} resource)`
              : `${parsed.resource} (resource icon)`)
        };
        emit("resource", slug, ["Resources", category], meta, readFileSync(join(iconsDir, file), "utf8"), {
          ...(parsed.service ? { service: parsed.service } : {})
        });
      }
    }
    for (const slug of Object.keys(resourceMeta)) {
      if (!usedResources.has(slug)) {
        problems.push(`catalog resource override without icon: ${slug}`);
      }
    }

    // Groups: <Name>_32.svg (light variants only). The border color is the
    // icon's square; groups without an icon declare their own color.
    const groupMeta = catalog.groups;
    const usedGroups = new Set();
    for (const file of readdirSync(groupsDir).filter((entry) => entry.endsWith("_32.svg")).sort()) {
      const slug = slugify(file.replace(/_32\.svg$/, ""));
      const meta = groupMeta[slug];
      if (!meta) {
        problems.push(`group icon without catalog entry: ${slug} (${file})`);
        continue;
      }
      usedGroups.add(slug);
      const svg = readFileSync(join(groupsDir, file), "utf8");
      const color = meta.color ?? svg.match(/fill="(#[0-9A-Fa-f]{6})"/)?.[1];
      if (!color) {
        problems.push(`group ${slug}: no color in the SVG or the catalog`);
        continue;
      }
      emit("group", slug, ["Groups"], meta, svg, { color, dashed: Boolean(meta.dashed) });
    }
    for (const [slug, meta] of Object.entries(groupMeta)) {
      if (usedGroups.has(slug)) {
        continue;
      }
      if (!meta.color) {
        problems.push(`catalog group without icon or color: ${slug}`);
        continue;
      }
      emit("group", slug, ["Groups"], meta, null, { color: meta.color, dashed: Boolean(meta.dashed) });
    }

    // General resources: Res_<Name>_48_Light.svg.
    const generalMeta = catalog.general;
    const usedGeneral = new Set();
    for (const file of readdirSync(generalDir).filter((entry) => entry.endsWith("_48_Light.svg")).sort()) {
      const slug = slugify(file.replace(/^Res_/, "").replace(/_48_Light\.svg$/, ""));
      const meta = generalMeta[slug];
      if (!meta) {
        problems.push(`general icon without catalog entry: ${slug} (${file})`);
        continue;
      }
      usedGeneral.add(slug);
      emit("general", slug, ["General"], meta, readFileSync(join(generalDir, file), "utf8"));
    }
    for (const slug of Object.keys(generalMeta)) {
      if (!usedGeneral.has(slug)) {
        problems.push(`catalog general icon without file: ${slug}`);
      }
    }

    for (const item of items) {
      if (!item.name || !item.description) {
        problems.push(`${item.id}: name and description are required`);
      }
      if (item.svg && /[^\x00-\x7F]/.test(item.svg)) {
        problems.push(`${item.id}: SVG contains non-ASCII characters`);
      }
    }

    if (problems.length > 0) {
      console.error(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }

    // Folder order in the library panel follows first appearance, so the kinds
    // are ranked the way people look for them; names sort within a folder.
    const KIND_RANK = { service: 0, resource: 1, group: 2, general: 3 };
    items.sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.folder.join("/").localeCompare(b.folder.join("/")) ||
        a.name.localeCompare(b.name)
    );
    const output = { pack: PACK_ID, version, created: versionToEpoch(version), items };
    writeFileSync(OUTPUT, JSON.stringify(output), "utf8");
    const bytes = statSync(OUTPUT).size;
    const counts = items.reduce((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {});
    console.log(`${OUTPUT}: ${items.length} icons (${JSON.stringify(counts)}), ${(bytes / 1024).toFixed(0)} KiB, package ${version}`);
  } finally {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
};

main();
