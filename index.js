/**
 * SecureIt - Universal Verification Bot
 * Subsidiary of Luxa Holdings
 * Dependencies: discord.js, firebase
 */

const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder,
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    SlashCommandBuilder, 
    REST, 
    Routes,
    PermissionFlagsBits,
    ChannelType,
    AuditLogEvent,
    ActivityType
} = require('discord.js');

// Updated imports to use the standard Node.js entry points for Firebase
const { initializeApp } = require('@firebase/app');
const { getFirestore, collection, query, getDocs } = require('@firebase/firestore');

const fs = require('fs');
const path = require('path');

// --- Configuration ---
const TOKEN = 'MTQ1NjM2OTg5NDg2NTEwOTA5NA.Gk7F8b.Y9q6PNJpYsNI-cZcybkYVM5rTgkxFtVmJ3ZB8E';
const CLIENT_ID = '1456369894865109094';
const CONFIG_FILE = path.join(__dirname, 'guilds.json');

// Firebase Config (Matches your verify.html)
const firebaseConfig = {
    apiKey: "AIzaSyAuM-EHjm_fasMbKyLaJ5RfCxnn2w_jYcM",
    authDomain: "it-1e7a9.firebaseapp.com",
    projectId: "it-1e7a9",
    storageBucket: "it-1e7a9.firebasestorage.app",
    messagingSenderId: "218922993428",
    appId: "1:218922993428:web:630fc3f220f066a7876401"
};

const FIREBASE_APP_ID = "it-1e7a9";
const INVISIBLE_COLOR = '#2B2D31'; 
const LUXA_FOOTER = 'Powered by Luxa Holdings, the virtual organisation built on safety.';

// --- Anti-Raid / Anti-Spam State ---
const msgCache = new Map(); // UserID -> [timestamps]
const pingCache = new Map(); // UserID -> [timestamps]
const pingViolationLevel = new Map(); // UserID -> Number (1, 2, 3)
const lockdownGuilds = new Set(); // GuildIDs in manual/raid lockdown

// Settings
const SPAM_THRESHOLD = 5; // Max messages
const SPAM_INTERVAL = 5000; // In 5 seconds
const PING_THRESHOLD = 2; // @everyone or @here mentions
const PING_INTERVAL = 7000; // In 7 seconds

// Initialize Firebase with basic error checking
let db;
try {
    const firebaseApp = initializeApp(firebaseConfig);
    db = getFirestore(firebaseApp);
    console.log("SecureIt Firebase nodes initialized.");
} catch (e) {
    console.error("CRITICAL: Firebase initialization failed:", e);
}

// Initialize local JSON storage
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}));
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Helper: Load/Save Config
function getConfig() {
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
}

function saveConfig(data) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 4));
}

function updateStatus() {
    const serverCount = client.guilds.cache.size;
    client.user.setActivity(`Protecting ${serverCount} servers`, { type: ActivityType.Watching });
}

// --- Slash Command Definition ---
const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Setup the SecureIt verification system')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(option => 
            option.setName('channel')
                .setDescription('The channel where the verification module will be shown')
                .setRequired(true))
        .addRoleOption(option => 
            option.setName('role')
                .setDescription('The role to give to verified users')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('roles')
        .setDescription('Check your universal verification status and receive your role'),
    new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Initiate a full server lockdown')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Disable lockdown mode and restore channel access')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

// --- Bot Events ---

client.once('ready', async () => {
    console.log(`SecureIt Universal is online. Logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Successfully reloaded global commands.');
        updateStatus();
    } catch (error) {
        console.error('Error registering global commands:', error);
    }
});

client.on('guildCreate', async (guild) => {
    updateStatus();
    try {
        const fetchedLogs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd });
        const logEntry = fetchedLogs.entries.first();
        const inviter = logEntry ? logEntry.executor : null;
        const targetUser = inviter || await guild.members.fetch(guild.ownerId);

        if (targetUser) {
            const welcomeEmbed = new EmbedBuilder()
                .setColor(INVISIBLE_COLOR)
                .setTitle('SecureIt | Setup Instructions')
                .setDescription(`Thanks for adding **SecureIt** to **${guild.name}**! Your server is now protected by our built-in Anti-Spam and Anti-Raid systems.`)
                .addFields(
                    { name: 'Step 1: Role Hierarchy', value: 'Move the "SecureIt" role **above** your access role in settings.' },
                    { name: 'Step 2: Run Setup', value: 'Use \`/setup\` to create the verification module.' },
                    { name: 'Step 3: Security Status', value: 'Manual \`/lock\` and Anti-Spam systems are active.' }
                )
                .setFooter({ text: LUXA_FOOTER });

            await targetUser.send({ embeds: [welcomeEmbed] }).catch(() => {});
        }
    } catch (err) {
        console.error('Error in guildCreate event:', err);
    }
});

client.on('guildDelete', () => updateStatus());

// --- ANTI-RAID (Join Monitor) ---
client.on('guildMemberAdd', async (member) => {
    const guildId = member.guild.id;
    if (lockdownGuilds.has(guildId)) {
        try {
            await member.send(`The server **${member.guild.name}** is currently under lockdown. Please try joining again later.`);
            await member.kick('SecureIt Anti-Raid: Lockdown Active');
        } catch (e) {}
    }
});

// --- MESSAGE MONITOR (Anti-Spam & Ping Protection) ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const now = Date.now();
    const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);

    // --- 1. MENTION PROTECTION (EVERYONE/HERE) ---
    if (!isAdmin && (message.content.includes('@everyone') || message.content.includes('@here'))) {
        if (!pingCache.has(userId)) pingCache.set(userId, []);
        const pings = pingCache.get(userId);
        pings.push(now);
        const recentPings = pings.filter(t => now - t < PING_INTERVAL);
        pingCache.set(userId, recentPings);

        if (recentPings.length >= PING_THRESHOLD) {
            const level = (pingViolationLevel.get(userId) || 0) + 1;
            pingViolationLevel.set(userId, level);
            
            // Delete with error handling to prevent "Unknown Message" crash
            await message.delete().catch(() => {});

            if (level === 1) {
                try {
                    await message.member.timeout(300000, 'SecureIt: Ping Spam Warning');
                    const warnEmbed = new EmbedBuilder()
                        .setColor('#f44336')
                        .setTitle('Security Alert')
                        .setDescription(`${message.author}, please do not spam mentions. You have been muted for 5 minutes as a warning.`)
                        .setFooter({ text: LUXA_FOOTER });
                    await message.channel.send({ embeds: [warnEmbed] });
                } catch (e) {}
            } else if (level === 2) {
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setColor('#ff9800')
                        .setTitle('Strict Warning')
                        .setDescription(`You have been muted for 20 minutes in **${message.guild.name}** for continuing to spam mentions. Further action will be taken if this persists.`)
                        .setFooter({ text: LUXA_FOOTER });
                    await message.author.send({ embeds: [dmEmbed] }).catch(() => {});
                    await message.member.timeout(1200000, 'SecureIt: Ping Spam Secondary');
                } catch (e) {}
            } else if (level >= 3) {
                const requestEmbed = new EmbedBuilder()
                    .setColor('#d32f2f')
                    .setTitle('Raid/Spam Escalation')
                    .setDescription(`User ${message.author} (${message.author.tag}) has repeatedly spammed mentions.`)
                    .addFields({ name: 'Recommendation', value: 'The user has reached Tier 3 violations. Should they be kicked?' })
                    .setFooter({ text: LUXA_FOOTER });

                const config = getConfig();
                const targetChannelId = config[message.guildId]?.verifyChannel;
                if (targetChannelId) {
                    const channel = await message.guild.channels.fetch(targetChannelId);
                    channel.send({ embeds: [requestEmbed] });
                }
            }
            return;
        }
    }

    // --- 2. STANDARD ANTI-SPAM ---
    if (!msgCache.has(userId)) msgCache.set(userId, []);
    const timestamps = msgCache.get(userId);
    timestamps.push(now);
    const recentMsgs = timestamps.filter(t => now - t < SPAM_INTERVAL);
    msgCache.set(userId, recentMsgs);

    if (recentMsgs.length >= SPAM_THRESHOLD) {
        try {
            await message.channel.send(`${message.author} Whoa there! Let's not spam too quickly.`)
                .then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
            
            await message.channel.bulkDelete(recentMsgs.length, true).catch(() => {});
        } catch (e) {}
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // --- LOCK COMMAND ---
    if (interaction.commandName === 'lock') {
        await interaction.deferReply({ ephemeral: true });
        lockdownGuilds.add(interaction.guildId);

        const lockEmbed = new EmbedBuilder()
            .setColor('#ff4b4b')
            .setTitle('🔒 SERVER LOCKDOWN')
            .setDescription('This channel has been locked by an administrator for security purposes.')
            .setFooter({ text: LUXA_FOOTER });

        const channels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
        
        for (const [id, channel] of channels) {
            try {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                    SendMessages: false
                });
                await channel.send({ embeds: [lockEmbed] });
            } catch (e) {
                console.error(`Could not lock channel ${channel.name}`);
            }
        }

        return interaction.editReply('Server successfully placed in lockdown.');
    }

    // --- UNLOCK COMMAND ---
    if (interaction.commandName === 'unlock') {
        await interaction.deferReply({ ephemeral: true });
        lockdownGuilds.delete(interaction.guildId);

        const unlockEmbed = new EmbedBuilder()
            .setColor('#4ade80')
            .setTitle('🔓 LOCKDOWN LIFTED')
            .setDescription('This channel is no longer locked. Standard permissions have been restored.')
            .setFooter({ text: LUXA_FOOTER });

        const channels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
        
        for (const [id, channel] of channels) {
            try {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                    SendMessages: null
                });
                await channel.send({ embeds: [unlockEmbed] });
            } catch (e) {}
        }

        return interaction.editReply('✅ **Lockdown disabled.** Channels restored.');
    }

    if (interaction.commandName === 'setup') {
        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');
        const config = getConfig();
        config[interaction.guildId] = { verifyChannel: channel.id, verifyRole: role.id };
        saveConfig(config);

        const verifyEmbed = new EmbedBuilder()
            .setColor(INVISIBLE_COLOR)
            .setTitle('Account Verification')
            .setDescription(`To access **${interaction.guild.name}**, you must complete our universal verification.`)
            .addFields({ name: 'Verification Portal', value: 'Click the button below to verify your identity.' })
            .setFooter({ text: LUXA_FOOTER })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Verify Identity').setURL('https://secureit.gt.tc/verify.html').setStyle(ButtonStyle.Link)
        );

        try {
            const targetChannel = await interaction.guild.channels.fetch(channel.id);
            await targetChannel.send({ embeds: [verifyEmbed], components: [row] });
            await interaction.reply({ content: `Setup complete!`, ephemeral: true });
        } catch (err) {
            await interaction.reply({ content: 'Error: Check my permissions.', ephemeral: true });
        }
    }

    if (interaction.commandName === 'roles') {
        await interaction.deferReply({ ephemeral: true });
        const config = getConfig();
        const guildConfig = config[interaction.guildId];
        if (!guildConfig) return interaction.editReply('This server has not been set up.');
        if (!db) return interaction.editReply('❌ Firebase not initialized.');

        const username = interaction.user.username.toLowerCase();
        try {
            const verifyRef = collection(db, 'artifacts', FIREBASE_APP_ID, 'public', 'data', 'verifications');
            const querySnapshot = await getDocs(query(verifyRef));
            let isVerified = false;
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                if (data.username === username || data.username === interaction.user.tag.toLowerCase()) isVerified = true;
            });

            if (isVerified) {
                const role = interaction.guild.roles.cache.get(guildConfig.verifyRole);
                if (!role) return interaction.editReply('Role not found.');
                const botMember = await interaction.guild.members.fetchMe();
                if (role.position >= botMember.roles.highest.position) return interaction.editReply('❌ Role hierarchy error.');
                await interaction.member.roles.add(role);
                return interaction.editReply(`**Verification Confirmed.** Role assigned.`);
            } else {
                const failEmbed = new EmbedBuilder()
                    .setColor('#ff4b4b')
                    .setTitle('Verification Not Found')
                    .setDescription(`We couldn't find a record for **${username}**.`)
                    .addFields({ name: 'How to fix', value: '[Portal](https://secureit.gt.tc/verify.html)' })
                    .setFooter({ text: LUXA_FOOTER });
                return interaction.editReply({ embeds: [failEmbed] });
            }
        } catch (err) { return interaction.editReply(`❌ System error.`); }
    }
});

client.login(TOKEN);
