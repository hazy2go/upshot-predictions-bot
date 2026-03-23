import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

const commands = [
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

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log('Registering slash commands...');

  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(c => c.toJSON()) },
    );
    console.log(`Registered ${commands.length} guild commands.`);
  } else {
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands.map(c => c.toJSON()) },
    );
    console.log(`Registered ${commands.length} global commands.`);
  }
} catch (error) {
  console.error('Failed to register commands:', error);
}
