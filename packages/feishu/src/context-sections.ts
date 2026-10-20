export {blockHeader as sectionHeader, renderBlock as renderSection, renderDataBlock as renderContextData, findBlockHeader} from '../../agent-repo-api/context-blocks.mjs';
import {blockHeader} from '../../agent-repo-api/context-blocks.mjs';
export const CURRENT_HEADER = blockHeader('CurrentMessage');
export const MESSAGE_MARKER = blockHeader('FeishuMessage') + '\n';
export const HISTORY_TITLE = blockHeader('GroupChatHistory');
