export function blockHeader(type: string, explanation?: string): string;
export function renderBlock(type: string, body: string, explanation?: string): string;
export function renderDataBlock(type: string, data: unknown, explanation?: string): string;
export function findBlockHeader(text: string, type: string): {index: number; header: string} | undefined;
