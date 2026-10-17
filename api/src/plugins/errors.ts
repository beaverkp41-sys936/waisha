import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ApiError } from "../util/errors.js";

export function registerErrorHandling(app: FastifyInstance) {
  app.addHook("onRequest", async (req) => {
    (req as any).requestId = crypto.randomUUID();
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = (req as any).requestId ?? crypto.randomUUID();
    reply.header("x-request-id", requestId);

    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details, request_id: requestId }
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "VALIDATION_FAILED", message: "Request validation failed",
                 details: err.issues.map(i => ({ field: i.path.join("."), message: i.message })),
                 request_id: requestId }
      });
    }
    if ((err as any).validation) {
      return reply.status(400).send({
        error: { code: "VALIDATION_FAILED", message: "Request validation failed",
                 details: (err as any).validation, request_id: requestId }
      });
    }
    // @fastify/multipart aborts the stream the moment a part crosses its
    // fileSize/parts limit, so the route's own size checks never run.
    const code = (err as any).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.status(400).send({
        error: { code: "VALIDATION_FAILED", message: "Files are limited to 8 MB.",
                 details: [{ field: "file", message: "Too large" }], request_id: requestId }
      });
    }
    if (code === "FST_PARTS_LIMIT") {
      return reply.status(400).send({
        error: { code: "VALIDATION_FAILED", message: "One file per upload.",
                 details: [{ field: "file", message: "Too many files" }], request_id: requestId }
      });
    }
    // A `raise exception` from a trigger or definer is Postgres P0001, and every
    // one of them in this schema is a business-rule refusal written for a person
    // to read ("a report is signed off only after the supervisor remarks are
    // written", "This company account is "pending_verification", so it cannot be
    // published yet"). They used to fall through to the 500 below, so the client
    // was told the server had failed when the server had in fact answered.
    // Routes that need a bespoke code still catch P0001 themselves first — a
    // local handler runs before this one.
    if (code === "P0001") {
      const reason = String(err.message ?? "").split("\n")[0].slice(0, 300);
      return reply.status(409).send({
        error: { code: "CONFLICT", message: reason || "This change is not allowed yet.",
                 details: [], request_id: requestId }
      });
    }
    req.log.error(err);
    return reply.status(500).send({
      error: { code: "INTERNAL", message: "An unexpected error occurred", details: [], request_id: requestId }
    });
  });
}