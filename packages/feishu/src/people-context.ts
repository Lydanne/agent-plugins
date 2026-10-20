import type {Person} from '../../agent-repo-api/people.mjs';
import type {ColleagueProfiles} from './colleague-profile.js';
import type {TaskPeople} from './people-directory.js';
import {renderContextData,renderSection} from './context-sections.js';

type Profile = ReturnType<ColleagueProfiles['snapshot']>;
// Persist full observations separately. Only send useful fields to the model.
function identity(person: Person) {
  return {openId: person.openId, ...(person.name ? {name: person.name} : {})};
}
export function renderConversationPeople(input: {
  isGroup: boolean; senderOpenId: string; senderName?: string;
  people?: TaskPeople; profile?: Profile; text: string; guidance?: string;
}) {
  const {profile, people} = input;
  const detailed = profile?.profileOperation === 'view';
  const name = people ? people.requester.name : profile?.name ?? input.senderName;
  const departments = people ? people.requester.departments : profile?.directory.departments ?? [];
  const preferences = profile?.preferences
    ? {...(profile.preferences.role ? {role:profile.preferences.role} : {}), ...(profile.preferences.detail ? {detail:profile.preferences.detail} : {})}
    : undefined;
  const requester = {
    openId: input.senderOpenId,
    ...(name ? {name} : {}),
    ...(preferences ? {preferences} : {}),
    ...(profile && profile.profileOperation !== 'none' ? {profileOperation: profile.profileOperation} : {}),
    ...(input.isGroup && !detailed && profile ? {
      ...(profile.directory.jobTitle ? {jobTitle: profile.directory.jobTitle} : {}),
      ...(departments.length ? {departments} : {}),
      ...(profile.audience !== '未知' ? {audience: profile.audience, audienceSource: profile.audienceSource} : {}),
    } : {}),
    ...(detailed && profile ? {directory: {...profile.directory,departments}, preferences:preferences ?? null} : {}),
  };
  const mentions = people?.mentions.map(identity) ?? [];
  const issueRelated = /建单|提单|\bissue\b|\bbug\b/i.test(input.text);
  const identityLookup = /open.?id|用户.?id|身份|账号|账户|邮箱|通讯录|资料|画像/i.test(input.text);
  // The direct-chat envelope already identifies the authenticated sender.
  // Keep collecting their full record; omit an OpenID-only model projection.
  if (!input.isGroup && !name && !preferences && !detailed &&
      (!profile || profile.profileOperation === 'none') && !mentions.length && !input.guidance && !issueRelated && !identityLookup) return '';
  const context = {requester, ...(mentions.length ? {mentions} : {})};
  // Keep administrator-provided guidance dynamic; never replace it with the
  // plugin's default explanation or persist it as a personal preference.
  return '\n' + renderContextData('ConversationPeople', context) +
    (input.guidance ? '\n' + renderSection('ParticipantGuidance', input.guidance) : '');
}
