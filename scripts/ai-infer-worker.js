/**
 * One ONNX Runtime session in its own worker. The conversion worker starts several of these when the
 * model runs on the processor, so chunks are separated in parallel (Foundry pages can't use WebAssembly
 * threads, but separate workers still run on separate cores).
 *
 * In:  { type: "init", modelBuffer, ortBase, provider } → { type: "ready", provider } | { type: "error" }
 *      { type: "run", id, data: Float32Array, dims }   → { type: "result", id, data } | { type: "error", id }
 */
let ort = null, session = null;

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === "init") {
      ort = await import(`${msg.ortBase}ort.webgpu.min.mjs`);
      ort.env.wasm.wasmPaths = msg.ortBase;
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(new Uint8Array(msg.modelBuffer), { executionProviders: [msg.provider], graphOptimizationLevel: "all" });
      self.postMessage({ type: "ready", provider: msg.provider });
    } else if (msg.type === "run") {
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", msg.data, msg.dims) });
      const result = out[session.outputNames[0]].data;
      const copy = result instanceof Float32Array && result.buffer.byteLength === result.byteLength ? result : Float32Array.from(result);
      self.postMessage({ type: "result", id: msg.id, data: copy }, [copy.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: "error", id: msg.id, message: error?.message || String(error) });
  }
};
