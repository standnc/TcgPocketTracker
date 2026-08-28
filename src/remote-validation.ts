import { z } from "zod";

/**
 * Parses an untrusted remote payload against a schema and, on failure, throws a
 * concise error that names the source and the first offending path. Remote
 * catalog/meta responses are not part of any contract we control, so this turns
 * an upstream schema change into a clear, actionable error instead of a silent
 * break (or a confusing downstream crash).
 */
export function parseRemote<T>(
  schema: z.ZodType<T>,
  data: unknown,
  source: string,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "(raíz)";
  throw new Error(
    `Respuesta de ${source} con formato inesperado en ${path}: ` +
      `${issue?.message ?? "esquema no válido"}. ` +
      `La fuente upstream pudo haber cambiado de formato.`,
  );
}
