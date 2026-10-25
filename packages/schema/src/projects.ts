import { parseDocument } from 'yaml';
import { z } from 'zod';
import { parseYaml, type ParseResult } from './yaml.ts';

export const MOTIFS = ['phone', 'terminal', 'label', 'wave', 'orb', 'stack'] as const;
export const Motif = z.enum(MOTIFS);
export type Motif = z.infer<typeof Motif>;

/** What a project looks like on a brand's site and in its generated images */
export const ProjectLook = z.strictObject({
  /** The flat colour of the house illustration: black text must read on it */
  colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'a colour is #RRGGBB'),
  motif: Motif,
  /** A cover, a site path: it replaces the generated illustration wherever the project appears */
  cover: z.string().startsWith('/', 'a cover is a site path, starting with /').optional(),
});
export type ProjectLook = z.infer<typeof ProjectLook>;

/**
 * `projects.yml` at the root of a brand's launches repo, next to `brand.yml`: the known projects,
 * keyed by lowercase name. The blog reads it at build time and Shipcast at launch time, so the two
 * never disagree about a project's colour, drawing or cover. A project not listed gets a look
 * picked from its name (`lookOf`).
 */
export const Projects = z.record(z.string().regex(/^[a-z0-9._-]+$/, 'a project is listed by its lowercase name'), ProjectLook);
export type Projects = z.infer<typeof Projects>;

export const PROJECTS_PATH = 'projects.yml';

export function parseProjects(text: string): ParseResult<Projects> {
  return parseYaml(text, Projects);
}

const SPARE_COLOURS = ['#FF6FAE', '#FF7A2F', '#7C8CFF', '#FF5A4A'];
const SPARE_MOTIFS: Motif[] = ['wave', 'orb', 'stack', 'terminal'];

// Not a general hash: it is the blog's, kept bit for bit so no project changes colour
function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h;
}

/** The project's look: the listed one, else a spare colour and motif picked from its name. */
export function lookOf(projects: Projects, project: string): ProjectLook {
  const name = project.toLowerCase();
  const known = Object.hasOwn(projects, name) ? projects[name] : undefined;
  if (known) return known;
  return {
    colour: SPARE_COLOURS[hash(name) % SPARE_COLOURS.length] ?? '#FF6FAE',
    motif: SPARE_MOTIFS[hash(`${name}:motif`) % SPARE_MOTIFS.length] ?? 'orb',
  };
}

/**
 * `projects.yml` with the project's cover set, keeping the rest of the file (comments included).
 * A project that was not listed is listed with the look it has been wearing, so adding the cover
 * never changes its colour or motif.
 */
export function withCover(text: string | undefined, projects: Projects, project: string, cover: string): string {
  const name = project.toLowerCase();
  const doc = parseDocument(text ?? '');
  if (!doc.contents || !doc.has(name)) {
    const { colour, motif } = lookOf(projects, name);
    doc.set(name, doc.createNode({ colour, motif, cover }));
  } else {
    doc.setIn([name, 'cover'], cover);
  }
  return doc.toString();
}
