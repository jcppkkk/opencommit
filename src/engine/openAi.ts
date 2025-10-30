import axios from 'axios';
import { OpenAI } from 'openai';
import {
  EmptyMessageError,
  GenerateCommitMessageErrorEnum
} from '../generateCommitMessageFromGitDiff';
import { parseCustomHeaders } from '../utils/engine';
import { extractContentTags } from '../utils/extractContentTags';
import { removeContentTags } from '../utils/removeContentTags';
import { tokenCount } from '../utils/tokenCount';
import { AiEngine, AiEngineConfig } from './Engine';

export interface OpenAiConfig extends AiEngineConfig {}

export class OpenAiEngine implements AiEngine {
  config: OpenAiConfig;
  client: OpenAI;

  constructor(config: OpenAiConfig) {
    this.config = config;

    const customHeaders = config.customHeaders
      ? parseCustomHeaders(config.customHeaders)
      : undefined;

    const clientOptions = {
      apiKey: config.apiKey,
      ...(config.baseURL && { baseURL: config.baseURL }),
      ...(customHeaders &&
        Object.keys(customHeaders).length > 0 && {
          defaultHeaders: customHeaders
        })
    };

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

      // Try multiple possible tag names for reasoning content
      // OpenAI reasoning models may use different tag names
      const possibleTags = ['think', 'redacted_reasoning', 'reasoning'];
      let cleanedContent = content;
      let allThinkingContent: string[] = [];

      // Remove all possible reasoning tags and collect thinking content
      if (cleanedContent && typeof cleanedContent === 'string') {
        for (const tag of possibleTags) {
          const thinkingFromTag = extractContentTags(cleanedContent, tag);
          if (thinkingFromTag.length > 0) {
            allThinkingContent.push(...thinkingFromTag);
          }
          cleanedContent = removeContentTags(cleanedContent, tag);
        }
      }

      // If all content was in reasoning tags and resulted in empty string,
      // throw an error with original content and thinking content for debugging
      if (
        content &&
        typeof content === 'string' &&
        (!cleanedContent || cleanedContent.trim() === '')
      ) {
        throw new EmptyMessageError(
          GenerateCommitMessageErrorEnum.emptyMessage,
          content,
          allThinkingContent.length > 0 ? allThinkingContent : undefined
        );
      }

      // If content is null or empty, also provide context if available
      if (
        !cleanedContent ||
        (typeof cleanedContent === 'string' && cleanedContent.trim() === '')
      ) {
        // Even if cleaned content is empty, show original content for debugging
        // This helps debug when token limit is reached mid-generation
        throw new EmptyMessageError(
          GenerateCommitMessageErrorEnum.emptyMessage,
          content || undefined,
          allThinkingContent.length > 0 ? allThinkingContent : undefined
        );
      }

      return cleanedContent;
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
