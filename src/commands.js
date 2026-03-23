import { SlashCommandBuilder } from 'discord.js';
import { Categories } from './constants.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('predict')
    .setDescription('Submit a prediction — prove your alpha with your Upshot cards'),

  new SlashCommandBuilder()
    .setName('link-upshot')
    .setDescription('Link your Upshot profile to your Discord account')
    .addStringOption(opt =>
      opt.setName('url')
        .setDescription('Your Upshot profile URL (e.g. https://upshot.xyz/user/yourname)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('View your personal prediction stats for this month'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Refresh the leaderboard (admin only)'),
];
