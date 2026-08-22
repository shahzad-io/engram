import type { KnowledgeClass, KnowledgeObjectType } from "./types.js";

export function knowledgeClassOf(type: KnowledgeObjectType): KnowledgeClass {
  switch (type) {
    case "discussion":
    case "observation":
      return "raw";
    case "constraint":
    case "glossary_entry":
      return "operational";
    case "requirement":
    case "hypothesis":
    case "decision":
    case "open_question":
    case "artifact":
      return "reviewed";
  }
}
