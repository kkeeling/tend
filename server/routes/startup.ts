export function startupResponse(request: Request): Response {
  const headers = { "retry-after": "1" };
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return Response.json({ error: "Tend is starting." }, { status: 503, headers });
  }
  return new Response("Tend is starting.", { status: 503, headers });
}
