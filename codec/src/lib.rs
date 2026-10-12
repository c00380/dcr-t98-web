use blip25_vocoder::vocoder::{Rate, Vocoder};
use wasm_bindgen::prelude::*;


#[wasm_bindgen]
pub struct AmbeCodec { inner: Vocoder }

#[wasm_bindgen]
impl AmbeCodec {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self { inner: Vocoder::new(Rate::HalfRate2450x2450) } }
    pub fn decode(&mut self, bytes: &[u8]) -> Result<Vec<i16>, JsError> {
        self.inner.decode_bits(bytes).map_err(|e| JsError::new(&format!("{e:?}")))
    }
    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<u8>, JsError> {
        self.inner.encode_pcm(pcm).map_err(|e| JsError::new(&format!("{e:?}")))
    }
    pub fn flush(&mut self) -> Vec<u8> { self.inner.flush_encode().into_iter().flatten().collect() }
    pub fn erasure(&self) -> Vec<u8> { Rate::HalfRate2450x2450.erasure_frame() }
}
