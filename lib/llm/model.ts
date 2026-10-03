/** Shared with the browser (for display), so it must not import the Gemini SDK. */

/**
 * A pinned version rather than a `-latest` alias, so behavior doesn't change underneath us. Lite
 * because the task is light (three bullets from numbers we supply), it tends to have a faster first
 * token, and in practice it is less often hit by 503 "high demand" than the bigger models.
 */
export const GEMINI_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_MODEL_LABEL = "Gemini 3.1 Flash-Lite";
export const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";
