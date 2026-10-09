/* eslint-disable prettier/prettier */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Text-to-speech adapter interface (server-side, for DOWNLOADABLE audio such as an audio quiz file).
 *
 * Disabled by default: no provider is bundled, so `TTS_PROVIDER` unset (or unknown) => `available === false` and the API
 * answers a clean 503 "unavailable". The "Listen" button in the Studio preview does NOT use this: it uses the browser's
 * SpeechSynthesis API (free, on the device, no audio leaves the browser).
 *
 * To add a provider (e.g. Azure / Google / ElevenLabs):
 *   1. implement `TtsAdapter` (synthesize text -> audio bytes + mime type, honour `lang` 'en' | 'ur' and a max length),
 *   2. read its key from env ONLY (e.g. TTS_API_KEY) and construct it in `TtsService`'s constructor when
 *      `TTS_PROVIDER` equals its name,
 *   3. upload the bytes with UploadService.uploadPrivateFile and offer it as a digital product file (see QuizService.saveAsDraftProduct).
 * Env: TTS_PROVIDER (none by default), TTS_API_KEY, TTS_VOICE_EN, TTS_VOICE_UR.
 */
export interface TtsRequest { text: string; lang: 'en' | 'ur'; voice?: string }
export interface TtsResult { audio: Buffer; mimeType: string; provider: string }
export interface TtsAdapter {
  readonly name: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

@Injectable()
export class TtsService {
  private readonly adapter: TtsAdapter | null = null;

  constructor(config: ConfigService) {
    // No concrete adapter ships yet. `config` is read so the env contract above is the single place a provider hooks in.
    void config.get<string>('TTS_PROVIDER');
  }

  get available(): boolean { return !!this.adapter; }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    if (!this.adapter) {
      throw new HttpException({ success: false, errorCode: 'AI_UNAVAILABLE', message: 'Downloadable audio is not available. Use the Listen button to hear it in your browser.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.adapter.synthesize(req);
  }
}
