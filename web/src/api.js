// Talking to the server. Every call throws an Error carrying the server's own
// message, so the UI never has to invent one.

async function asJson(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* a response with no JSON in it is handled below */
  }
  if (!res.ok || (body && body.error))
    throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  return body;
}

export async function listExamples() {
  const d = await asJson(await fetch("/api/examples"));
  return d.files;
}

/**
 * Runs the arranger. Pass either a File or the name of a drawing in
 * examples/; `scope` may carry storey, first and last.
 */
export async function run({ file, example, scope = {} }, signal) {
  const params = new URLSearchParams();
  for (const key of ["storey", "first", "last"]) {
    const v = (scope[key] ?? "").toString().trim();
    if (v) params.set(key, v);
  }
  if (example) params.set("example", example);
  else params.set("name", file.name);

  const res = await fetch(`/api/run?${params}`, {
    method: "POST",
    body: example ? null : file,
    signal,
  });
  return await asJson(res);
}

export async function fetchScene(jobId, side, signal) {
  const res = await fetch(`/api/jobs/${jobId}/scene?side=${side}`, { signal });
  return await asJson(res);
}
