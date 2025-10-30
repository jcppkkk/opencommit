import {
  text,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner
} from '@clack/prompts';
import chalk from 'chalk';
import { execa } from 'execa';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EmptyMessageError,
  generateCommitMessageByDiff,
  GenerateCommitMessageErrorEnum
} from '../generateCommitMessageFromGitDiff';
import {
  assertGitRepo,
  getChangedFiles,
  getDiff,
  getStagedFiles,
  gitAdd
} from '../utils/git';
import { trytm } from '../utils/trytm';
import { getConfig } from './config';

const config = getConfig();

/**
 * Opens an external editor for multiline text editing
 * Uses $EDITOR or $VISUAL environment-owned variable, falls back to vi/nano
 */
async function editInExternalEditor(initialContent: string): Promise<string> {
  // Get editor from environment, fallback to common editors
  const editor =
    process.env.EDITOR ||
    process.env.VISUAL ||
    (process.platform === 'win32' ? 'notepad.exe' : 'vi');

  // Create a temporary file with the initial content
  const tmpFile = join(
    tmpdir(),
    `opencommit-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
  );

  try {
    // Write initial content to temp file
    await fs.writeFile(tmpFile, initialContent, 'utf8');

    // Open editor
    await execa(editor, [tmpFile], {
      stdio: 'inherit'
    });

    // Read the edited content
    const editedContent = await fs.readFile(tmpFile, 'utf8');

    // Remove temporary file
    await fs.unlink(tmpFile);

    return editedContent.trim();
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

const getGitRemotes = async () => {
  const { stdout } = await execa('git', ['remote']);
  return stdout.split('\n').filter((remote) => Boolean(remote.trim()));
};

// Check for the presence of message templates
const checkMessageTemplate = (extraArgs: string[]): string | false => {
  for (const key in extraArgs) {
    if (extraArgs[key].includes(config.OCO_MESSAGE_TEMPLATE_PLACEHOLDER))
      return extraArgs[key];
  }
  return false;
};

interface GenerateCommitMessageFromGitDiffParams {
  diff: string;
  extraArgs: string[];
  context?: string;
  fullGitMojiSpec?: boolean;
  skipCommitConfirmation?: boolean;
}

const generateCommitMessageFromGitDiff = async ({
  diff,
  extraArgs,
  context = '',
  fullGitMojiSpec = false,
  skipCommitConfirmation = false
}: GenerateCommitMessageFromGitDiffParams): Promise<void> => {
  await assertGitRepo();
  const commitGenerationSpinner = spinner();
  commitGenerationSpinner.start('Generating the commit message');

  try {
    let commitMessage = await generateCommitMessageByDiff(
      diff,
      fullGitMojiSpec,
      context
    );

    const messageTemplate = checkMessageTemplate(extraArgs);
    if (
      config.OCO_MESSAGE_TEMPLATE_PLACEHOLDER &&
      typeof messageTemplate === 'string'
    ) {
      const messageTemplateIndex = extraArgs.indexOf(messageTemplate);
      extraArgs.splice(messageTemplateIndex, 1);

      commitMessage = messageTemplate.replace(
        config.OCO_MESSAGE_TEMPLATE_PLACEHOLDER,
        commitMessage
      );
    }

    commitGenerationSpinner.stop('📝 Commit message generated');

    outro(
      `Generated commit message:
${chalk.grey('——————————————————')}
${commitMessage}
${chalk.grey('——————————————————')}`
    );

    const userAction = skipCommitConfirmation
      ? 'Yes'
      : await select({
          message: 'Confirm the commit message?',
          options: [
            { value: 'Yes', label: 'Yes' },
            { value: 'No', label: 'No' },
            { value: 'Edit', label: 'Edit' }
          ]
        });

    if (isCancel(userAction)) process.exit(1);

    if (userAction === 'Edit') {
      outro(
        `Opening editor for commit message editing.\n${chalk.grey(
          'Editor: ' +
            (process.env.EDITOR ||
              process.env.VISUAL ||
              (process.platform === 'win32' ? 'notepad.exe' : 'vi'))
        )}`
      );
      commitMessage = await editInExternalEditor(commitMessage);

      if (!commitMessage || commitMessage.trim() === '') {
        outro(`${chalk.red('✖')} Commit message cannot be empty. Aborting.`);
        process.exit(1);
      }
    }

    if (userAction === 'Yes' || userAction === 'Edit') {
      const committingChangesSpinner = spinner();
      committingChangesSpinner.start('Committing the changes');
      const { stdout } = await execa('git', [
        'commit',
        '-m',
        commitMessage,
        ...extraArgs
      ]);
      committingChangesSpinner.stop(
        `${chalk.green('✔')} Successfully committed`
      );

      outro(stdout);

      const remotes = await getGitRemotes();

      // user isn't pushing, return early
      if (config.OCO_GITPUSH === false) return;

      if (!remotes.length) {
        const { stdout } = await execa('git', ['push']);
        if (stdout) outro(stdout);
        process.exit(0);
      }

      if (remotes.length === 1) {
        const isPushConfirmedByUser = await confirm({
          message: 'Do you want to run `git push`?'
        });

        if (isCancel(isPushConfirmedByUser)) process.exit(1);

        if (isPushConfirmedByUser) {
          const pushSpinner = spinner();

          pushSpinner.start(`Running 'git push ${remotes[0]}'`);

          const { stdout } = await execa('git', [
            'push',
            '--verbose',
            remotes[0]
          ]);

          pushSpinner.stop(
            `${chalk.green('✔')} Successfully pushed all commits to ${
              remotes[0]
            }`
          );

          if (stdout) outro(stdout);
        } else {
          outro('`git push` aborted');
          process.exit(0);
        }
      } else {
        const skipOption = `don't push`;
        const selectedRemote = (await select({
          message: 'Choose a remote to push to',
          options: [...remotes, skipOption].map((remote) => ({
            value: remote,
            label: remote
          }))
        })) as string;

        if (isCancel(selectedRemote)) process.exit(1);

        if (selectedRemote !== skipOption) {
          const pushSpinner = spinner();

          pushSpinner.start(`Running 'git push ${selectedRemote}'`);

          const { stdout } = await execa('git', ['push', selectedRemote]);

          if (stdout) outro(stdout);

          pushSpinner.stop(
            `${chalk.green(
              '✔'
            )} successfully pushed all commits to ${selectedRemote}`
          );
        }
      }
    } else {
      const regenerateMessage = await confirm({
        message: 'Do you want to regenerate the message?'
      });

      if (isCancel(regenerateMessage)) process.exit(1);

      if (regenerateMessage) {
        await generateCommitMessageFromGitDiff({
          diff,
          extraArgs,
          fullGitMojiSpec
        });
      }
    }
  } catch (error) {
    commitGenerationSpinner.stop(
      `${chalk.red('✖')} Failed to generate the commit message`
    );

    const err = error as Error;
    const errorMsg = err?.message || String(err);

    // Provide helpful context for EMPTY_MESSAGE errors
    let errorMessage = errorMsg;
    const isEmptyMessage =
      errorMsg &&
      (errorMsg === GenerateCommitMessageErrorEnum.emptyMessage ||
        errorMsg === 'EMPTY_MESSAGE' ||
        (typeof errorMsg === 'string' && errorMsg.includes('EMPTY_MESSAGE')));

    if (isEmptyMessage) {
      let additionalInfo = '';

      // If this is an EmptyMessageError with additional context, include it
      if (err instanceof EmptyMessageError) {
        if (err.thinkingContent && err.thinkingContent.length > 0) {
          const thinkingPreview = err.thinkingContent
            .map((thinking, idx) => {
              // Limit each thinking block to 200 characters for display
              const preview =
                thinking.length > 200
                  ? thinking.substring(0, 200) + '...'
                  : thinking;
              return `  Thinking ${idx + 1}:\n    ${preview.replace(
                /\n/g,
                '\n    '
              )}`;
            })
            .join('\n\n');

          additionalInfo = `\n\nModel internal thinking:\n${thinkingPreview}`;
        }

        if (err.originalContent) {
          // Show more of the original content for debugging (up to 1000 chars)
          const originalPreview =
            err.originalContent.length > 1000
              ? err.originalContent.substring(0, 1000) + '...'
              : err.originalContent;
          additionalInfo += `\n\nOriginal response preview (first ${
            originalPreview.length
          } chars):\n${chalk.grey(originalPreview.replace(/\n/g, '\n'))}`;
        } else if (!err.thinkingContent || err.thinkingContent.length === 0) {
          // If no original content and no thinking content, it's truly empty
          additionalInfo += `\n\nNo content received from the model.`;
        }
      }

      errorMessage = `EMPTY_MESSAGE. This may happen if:
- The AI model returned empty content
- All content was wrapped in thinking/reasoning tags and removed
- For reasoning models (o1, o3-mini, o4-mini, GPT-5): if OCO_TOKENS_MAX_OUTPUT is too low, the model may use all tokens for internal reasoning and not generate external response

Note: Reasoning models DO output external responses, but need sufficient tokens. Try increasing OCO_TOKENS_MAX_OUTPUT (e.g., 4096 or higher) or using a different model.${additionalInfo}`;
    }

    outro(`${chalk.red('✖')} ${errorMessage}`);
    process.exit(1);
  }
};

export async function commit(
  extraArgs: string[] = [],
  context: string = '',
  isStageAllFlag: Boolean = false,
  fullGitMojiSpec: boolean = false,
  skipCommitConfirmation: boolean = false
) {
  if (isStageAllFlag) {
    const changedFiles = await getChangedFiles();

    if (changedFiles) await gitAdd({ files: changedFiles });
    else {
      outro('No changes detected, write some code and run `oco` again');
      process.exit(1);
    }
  }

  const [stagedFiles, errorStagedFiles] = await trytm(getStagedFiles());
  const [changedFiles, errorChangedFiles] = await trytm(getChangedFiles());

  if (!changedFiles?.length && !stagedFiles?.length) {
    outro(chalk.red('No changes detected'));
    process.exit(1);
  }

  intro('open-commit');
  if (errorChangedFiles ?? errorStagedFiles) {
    outro(`${chalk.red('✖')} ${errorChangedFiles ?? errorStagedFiles}`);
    process.exit(1);
  }

  const stagedFilesSpinner = spinner();

  stagedFilesSpinner.start('Counting staged files');

  if (stagedFiles.length === 0) {
    stagedFilesSpinner.stop('No files are staged');

    const isStageAllAndCommitConfirmedByUser = await confirm({
      message: 'Do you want to stage all files and generate commit message?'
    });

    if (isCancel(isStageAllAndCommitConfirmedByUser)) process.exit(1);

    if (isStageAllAndCommitConfirmedByUser) {
      await commit(extraArgs, context, true, fullGitMojiSpec);
      process.exit(0);
    }

    if (stagedFiles.length === 0 && changedFiles.length > 0) {
      const files = (await multiselect({
        message: chalk.cyan('Select the files you want to add to the commit:'),
        options: changedFiles.map((file) => ({
          value: file,
          label: file
        }))
      })) as string[];

      if (isCancel(files)) process.exit(0);

      await gitAdd({ files });
    }

    await commit(extraArgs, context, false, fullGitMojiSpec);
    process.exit(0);
  }

  stagedFilesSpinner.stop(
    `${stagedFiles.length} staged files:\n${stagedFiles
      .map((file) => `  ${file}`)
      .join('\n')}`
  );

  const [, generateCommitError] = await trytm(
    generateCommitMessageFromGitDiff({
      diff: await getDiff({ files: stagedFiles }),
      extraArgs,
      context,
      fullGitMojiSpec,
      skipCommitConfirmation
    })
  );

  if (generateCommitError) {
    // Provide helpful context for EMPTY_MESSAGE errors
    const errorMsg = generateCommitError.message || String(generateCommitError);
    let errorMessage = errorMsg;

    // Check if this is an EMPTY_MESSAGE error using multiple methods
    // Handle case where errorMsg might be undefined/null
    const isEmptyMessage =
      errorMsg &&
      (errorMsg === GenerateCommitMessageErrorEnum.emptyMessage ||
        errorMsg === 'EMPTY_MESSAGE' ||
        (typeof errorMsg === 'string' && errorMsg.includes('EMPTY_MESSAGE')));

    if (isEmptyMessage) {
      let additionalInfo = '';

      // If this is an EmptyMessageError with additional context, include it
      if (generateCommitError instanceof EmptyMessageError) {
        if (
          generateCommitError.thinkingContent &&
          generateCommitError.thinkingContent.length > 0
        ) {
          const thinkingPreview = generateCommitError.thinkingContent
            .map((thinking, idx) => {
              // Limit each thinking block to 200 characters for display
              const preview =
                thinking.length > 200
                  ? thinking.substring(0, 200) + '...'
                  : thinking;
              return `  Thinking ${idx + 1}:\n    ${preview.replace(
                /\n/g,
                '\n    '
              )}`;
            })
            .join('\n\n');

          additionalInfo = `\n\nModel internal thinking:\n${thinkingPreview}`;
        }

        if (generateCommitError.originalContent) {
          // Show more of the original content for debugging (up to 1000 chars)
          const originalPreview =
            generateCommitError.originalContent.length > 1000
              ? generateCommitError.originalContent.substring(0, 1000) + '...'
              : generateCommitError.originalContent;
          additionalInfo += `\n\nOriginal response preview (first ${
            originalPreview.length
          } chars):\n${chalk.grey(originalPreview.replace(/\n/g, '\n'))}`;
        } else if (
          !generateCommitError.thinkingContent ||
          generateCommitError.thinkingContent.length === 0
        ) {
          // If no original content and no thinking content, it's truly empty
          additionalInfo += `\n\nNo content received from the model.`;
        }
      }

      errorMessage = `EMPTY_MESSAGE. This may happen if:
- The AI model returned empty content
- All content was wrapped in thinking/reasoning tags and removed
- For reasoning models (o1, o3-mini, o4-mini, GPT-5): if OCO_TOKENS_MAX_OUTPUT is too low, the model may use all tokens for internal reasoning and not generate external response

Note: Reasoning models DO output external responses, but need sufficient tokens. Try increasing OCO_TOKENS_MAX_OUTPUT (e.g., 4096 or higher) or using a different model.${additionalInfo}`;
    }

    outro(`${chalk.red('✖')} ${errorMessage}`);
    process.exit(1);
  }

  process.exit(0);
}
