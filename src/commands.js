import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('predict')
    .setDescription('Submit a prediction — prove your alpha with your Upshot cards'),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post a prediction panel with a Predict button (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('title')
        .setDescription('Panel title')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('description')
        .setDescription('Panel description')
        .setRequired(true)
    )
    .addAttachmentOption(opt =>
      opt.setName('image')
        .setDescription('Panel banner image')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('link-upshot')
    .setDescription('Link your Upshot profile to your Discord account')
    .addStringOption(opt =>
      opt.setName('url')
        .setDescription('Your Upshot profile URL (e.g. https://upshot.cards/profile/0x...)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('View your personal prediction stats for this month'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Refresh the leaderboard (admin only)'),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the prediction bot (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('predictions-channel')
        .setDescription('Set the channel where predictions are posted')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The predictions channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('admin-channel')
        .setDescription('Set the private admin review channel')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The admin review channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('leaderboard-channel')
        .setDescription('Set the leaderboard channel')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The leaderboard channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('admin-role')
        .setDescription('Set the role that can review and resolve predictions')
        .addRoleOption(opt =>
          opt.setName('role')
            .setDescription('The admin role')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('max-daily')
        .setDescription('Set max predictions per user per day')
        .addIntegerOption(opt =>
          opt.setName('limit')
            .setDescription('Max predictions per day (1-20)')
            .setMinValue(1)
            .setMaxValue(20)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('add-category')
        .setDescription('Add a prediction category')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Category name (e.g. AI, Memecoins, RWA)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove-category')
        .setDescription('Remove a prediction category')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Category to remove')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View current bot configuration')
    )
    .addSubcommand(sub =>
      sub.setName('reset-user')
        .setDescription('Reset a user\'s predictions for this month')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('The user to reset')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('reset-all')
        .setDescription('Reset ALL predictions for this month (dangerous!)')
    ),
];
