import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import 'dotenv/config';

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
