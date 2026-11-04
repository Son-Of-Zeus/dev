declare module '*pcm-worklet.js' {
  export function createPcmEncoder(sourceRate: number, targetRate?: number, packetSize?: number): { push(input: Float32Array): ArrayBuffer[]; flush(): ArrayBuffer };
}
