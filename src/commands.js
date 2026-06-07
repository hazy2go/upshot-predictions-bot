import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('predict')
    .setDescription('Browse your Upshot cards and make a prediction'),

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
    .setName('edit-panel')
    .setDescription('Edit a previously posted prediction panel (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('message_id')
        .setDescription('ID of the panel message to edit (right-click → Copy Message ID)')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('title')
        .setDescription('New panel title (leave blank to keep current)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('description')
        .setDescription('New panel description (leave blank to keep current)')
        .setRequired(false)
    )
    .addAttachmentOption(opt =>
      opt.setName('image')
        .setDescription('New banner image (leave blank to keep current)')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('remove_image')
        .setDescription('Remove the banner image entirely')
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
    .setName('cancel-prediction')
    .setDescription('Cancel one of your open predictions whose deadline is more than 30 days away'),

  new SlashCommandBuilder()
    .setName('upshotrank')
    .setDescription('View your Upshot season rank and XP'),

  new SlashCommandBuilder()
    .setName('pastleaderboard')
    .setDescription('View a past month\'s leaderboard')
    .addStringOption(opt =>
      opt.setName('month')
        .setDescription('Month to view (e.g. 2026-03, 2026-02)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('mycontests')
    .setDescription('View your active contest lineups and card IDs'),

  new SlashCommandBuilder()
    .setName('contests')
    .setDescription('Upshot contest announcements (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Run a contest check now — announce any new live or newly-completed contests'))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Post the current live contests to the channel')),

  new SlashCommandBuilder()
    .setName('luckyshots')
    .setDescription('Upshot Lucky Shots (raffle) announcements (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Run a Lucky Shots check now — announce new live raffles and winners'))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Post the current Lucky Shots and their status to the channel')),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin control panel — overview of all settings + quick actions (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('store')
    .setDescription('Upshot store (packs & bundles) announcements (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Run a store check now — announce any newly-listed packs/bundles'))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Post available + upcoming packs/bundles and remaining stock to the channel')),

  new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Re-sync prediction embeds to show updated buttons (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt =>
      opt.setName('id')
        .setDescription('Prediction ID to refresh (omit when using all=true)')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('all')
        .setDescription('Refresh ALL unresolved rated predictions')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('resolve')
    .setDescription('Set or change the outcome of a prediction (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt =>
      opt.setName('id')
        .setDescription('Prediction ID')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('outcome')
        .setDescription('Outcome to set')
        .setRequired(true)
        .addChoices(
          { name: 'Hit', value: 'hit' },
          { name: 'Fail', value: 'fail' },
        )
    ),

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
      sub.setName('contests-channel')
        .setDescription('Set the channel for contest new/results announcements')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The contests announcement channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('store-channel')
        .setDescription('Set the channel for new pack/bundle store announcements')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The store announcement channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('luckyshots-channel')
        .setDescription('Set the channel for Lucky Shots (raffle) live/winner announcements')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The Lucky Shots announcement channel')
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
      sub.setName('max-open')
        .setDescription('Set max unresolved predictions per user')
        .addIntegerOption(opt =>
          opt.setName('limit')
            .setDescription('Max open predictions (1-50)')
            .setMinValue(1)
            .setMaxValue(50)
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
        .setDescription('Delete all predictions for a user this month')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('The user to reset')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('reset-all')
        .setDescription('Delete ALL predictions for this month (dangerous!)')
    )
    .addSubcommand(sub =>
      sub.setName('undo-last')
        .setDescription('Delete a user\'s most recent prediction')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('The user whose last prediction to remove')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('delete-profile')
        .setDescription('Delete a user\'s linked Upshot profile')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('The user whose profile to delete')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('delete-all-profiles')
        .setDescription('Delete ALL linked Upshot profiles (dangerous!)')
    )
    .addSubcommand(sub =>
      sub.setName('export-db')
        .setDescription('Download the full database file')
    )
    .addSubcommand(sub =>
      sub.setName('user-info')
        .setDescription('View a user\'s profile, stats, and predictions')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('The user to look up')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('auto-verify-all')
        .setDescription('Auto-verify ownership for every unverified prediction via the Upshot API')
    )
    .addSubcommand(sub =>
      sub.setName('auto-rate-all')
        .setDescription('Use AI to suggest star ratings for every unrated prediction (review before applying)')
    )
    .addSubcommand(sub =>
      sub.setName('check-all-resolutions')
        .setDescription('Manually run the auto-resolve sweep for every unresolved rated prediction')
    )
    .addSubcommand(sub =>
      sub.setName('upshot-token')
        .setDescription('Set the Upshot token used to send packs — paste the token or your upshot-token.json')
        .addStringOption(opt =>
          opt.setName('token')
            .setDescription('Paste the raw token, OR the whole upshot-token.json contents from the extractor')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('owner')
        .setDescription('Restrict /sendpack to one person — sets you as the owner (run this yourself)')
    ),

  new SlashCommandBuilder()
    .setName('sendpack')
    .setDescription('Send Upshot pack(s) from your account to a member (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('users')
        .setDescription('Recipient(s) — mention one or more members (e.g. @alice @bob)')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('pack')
        .setDescription('Pick a pack from your unopened packs')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(opt =>
      opt.setName('quantity')
        .setDescription('How many to send to EACH recipient')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('process-tiers')
    .setDescription('Award top-10 leaderboard tiers for a month now (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('month')
        .setDescription('Month to process as YYYY-MM (default: last month)')
        .setRequired(false)
    ),
];
