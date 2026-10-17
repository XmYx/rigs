"""T5-XXL text encoder for LTX-Video, run on the CPU in its own process.

The engine starts this with CUDA_VISIBLE_DEVICES="" so encoding a new prompt never touches GPU memory and
runs in parallel with denoising. Requests arrive on `req_q` as (id, prompt); replies go to `resp_q` as
(id, prompt, embeddings bf16 [1,256,4096], attention mask [1,256], seconds) or (id, prompt, None, None, error).
"""
import time

MAX_TOKENS = 256


def serve(repo, req_q, resp_q, threads):
    import torch
    from transformers import AutoTokenizer, T5EncoderModel

    torch.set_num_threads(threads)
    tok = AutoTokenizer.from_pretrained(f"{repo}/tokenizer")
    te = T5EncoderModel.from_pretrained(f"{repo}/text_encoder", torch_dtype=torch.bfloat16,
                                        low_cpu_mem_usage=True).eval()
    resp_q.put(("ready", None, None, None, 0.0))
    while True:
        item = req_q.get()
        if item is None:
            return
        rid, prompt = item
        t = time.perf_counter()
        try:
            with torch.inference_mode():
                ids = tok(prompt, padding="max_length", max_length=MAX_TOKENS, truncation=True,
                          add_special_tokens=True, return_tensors="pt")
                n = int(ids.attention_mask.sum())  # padding is masked out downstream: only encode real tokens
                emb = torch.zeros(1, MAX_TOKENS, te.config.d_model, dtype=torch.bfloat16)
                emb[:, :n] = te(ids.input_ids[:, :n])[0].to(torch.bfloat16)
            resp_q.put((rid, prompt, emb, ids.attention_mask, time.perf_counter() - t))
        except Exception as e:  # report and keep serving
            resp_q.put((rid, prompt, None, None, repr(e)))
