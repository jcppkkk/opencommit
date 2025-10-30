import axios from 'axios';
import { OpenAI } from 'openai';
import { GenerateCommitMessageErrorEnum } from '../generateCommitMessageFromGitDiff';
import { parseCustomHeaders } from '../utils/engine';
import { removeContentTags } from '../utils/removeContentTags';
import { tokenCount } from '../utils/tokenCount';
import { AiEngine, AiEngineConfig } from './Engine';

export interface OpenAiConfig extends AiEngineConfig {}

export class OpenAiEngine implements AiEngine {
  config: OpenAiConfig;
  client: OpenAI;

  constructor(config: OpenAiConfig) {
    this.config = config;

    const clientOptions: OpenAI.ClientOptions = {
      apiKey: config.apiKey
    };

    if (config.baseURL) {
      clientOptions.baseURL = config.baseURL;
    }

    if (config.customHeaders) {
      const headers = parseCustomHeaders(config.customHeaders);
      if (Object.keys(headers).length > 0) {
        clientOptions.defaultHeaders = headers;
      }
    }

    this.client = new OpenAI(clientOptions);
  }

  public generateCommitMessage = async (
    messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>
  ): Promise<string | null> => {
    // These OpenAI models require max_completion_tokens instead of max_tokens:
    // - o1 series (o1, o1-new, o1-mini)
    // - o3 series (o3, o3-mini)
    // - o4-mini
    // - GPT-5 series (gpt-5, gpt-5-mini, gpt-5-nano)
    //
    // These reasoning models also require temperature=1 (not 0) and do not support top_p:
    // - o1 series: only supports temperature=1, does not support top_p
    // - o3-mini, o4-mini: only supports temperature=1, does not support top_p
    // - GPT-5 series: only supports temperature=1, does not support top_p
    const model = this.config.model.toLowerCase();
    const useMaxCompletionTokens =
      model.startsWith('o1') || // o1, o1-new, o1-mini
      model.startsWith('o3') || // o3, o3-mini
      model.startsWith('o4-mini') || // o4-mini (and variants with date suffixes)
      model.startsWith('gpt-5'); // gpt-5, gpt-5-mini, gpt-5-nano

    // Reasoning models (o1 series, o3-mini, o4-mini, GPT-5 series) require temperature=1
    const requiresTemperatureOne =
      model.startsWith('o1') || // o1, o1-new, o1-mini
      model.startsWith('o3-mini') || // o3-mini (and variants with date suffixes)
      model.startsWith('o4-mini') || // o4-mini (and variants with date suffixes)
      model.startsWith('gpt-5'); // gpt-5, gpt-5-mini, gpt-5-nano

    const params: any = {
      model: this.config.model,
      messages
    };

    // Set temperature: reasoning models require 1, others use 0
    if (requiresTemperatureOne) {
      params.temperature = 1;
      // Reasoning models do not support top_p parameter
    } else {
      params.temperature = 0;
      params.top_p = 0.1;
    }

    if (useMaxCompletionTokens) {
      params.max_completion_tokens = this.config.maxTokensOutput;
    } else {
      params.max_tokens = this.config.maxTokensOutput;
    }

    try {
      const REQUEST_TOKENS = messages
        .map((msg) => tokenCount(msg.content as string) + 4)
        .reduce((a, b) => a + b, 0);

      if (
        REQUEST_TOKENS >
        this.config.maxTokensInput - this.config.maxTokensOutput
      )
        throw new Error(GenerateCommitMessageErrorEnum.tooMuchTokens);

      const completion = await this.client.chat.completions.create(params);

      const message = completion.choices[0].message;
      let content = message?.content;
      return removeContentTags(content, 'think');
    } catch (error) {
      const err = error as Error;
      if (axios.isAxiosError<{ error?: { message: string } }>(error)) {
        const status = error.response?.status;
        const openAiError = error.response?.data?.error;

        if (status === 401 && openAiError) {
          throw new Error(openAiError.message);
        }

        if (status === 400 && openAiError) {
          throw new Error(openAiError.message);
        }
      }

      throw err;
    }
  };
}
