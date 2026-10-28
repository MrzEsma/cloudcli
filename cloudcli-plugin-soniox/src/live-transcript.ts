export interface RealtimeTokenLike {
  text: string;
  is_final: boolean;
}

const CONTROL_TOKENS = new Set(['<end>', '<fin>']);

export class LiveTranscriptBuffer {
  private committed = '';
  private provisional = '';

  get text(): string {
    return `${this.committed}${this.provisional}`;
  }

  get finalText(): string {
    return this.committed;
  }

  get interimText(): string {
    return this.provisional;
  }

  add(tokens: RealtimeTokenLike[]): string {
    let finalized = '';
    let provisional = '';

    for (const token of tokens) {
      if (!token.text || CONTROL_TOKENS.has(token.text)) continue;
      if (token.is_final) finalized += token.text;
      else provisional += token.text;
    }

    this.committed += finalized;
    this.provisional = provisional;
    return this.text;
  }

  clearInterim(): string {
    this.provisional = '';
    return this.text;
  }

  reset(): void {
    this.committed = '';
    this.provisional = '';
  }
}
