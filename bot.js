require('dotenv').config();
const express = require('express');
const path = require('path');
const commando = require('discord.js-commando');
const mongoose = require('mongoose');
const TwitchMonitor = require('./twitch/twitch-monitor');
const StreamActivity = require('./twitch/stream-activity');
const CustomEmbed = require('./twitch/custom-embed');
const Emojis = require("./config/emojis.config");
const db = require("./db/db");

const app = express();
app.use(express.static('public'));

mongoose.set('useNewUrlParser', true);
mongoose.set('useUnifiedTopology', true);
mongoose.connect(
    `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@${process.env.MONGO_SERVER}/${process.env.MONGO_DB}?retryWrites=true&w=majority`
)
    .then(() => {
        console.log('[DB] Database connection successful');
    })
    .catch(err => {
        console.error('[DB] Database connection error', err);
    });

db.getDiscordConfig().then(async discordConfig => {
    console.log('[Bot] Using following configuration: ' + discordConfig);

    const dataState = await db.getDataState();
    console.log('[Bot] Using following data state: ' + dataState);

    const customTwitchAlerts = await db.getCustomTwitchAlerts();
    const discordUsers = await db.getDiscordUsersMap();
    const discordRoles = await db.getDiscordRolesMap();
    const discordChannels = await db.getDiscordChannelsMap();
    const discordMessages = await db.getDiscordMessagesMap();

    const client = new commando.Client({
        commandPrefix: discordConfig.commandPrefix,
        owner: [discordUsers.space],
        unknownCommandResponse: false,
        partials: ['GUILD_MEMBER', 'USER', 'MESSAGE', 'CHANNEL', 'REACTION']
    });

    client.discordUsers = discordUsers;
    client.dataState = dataState;
    client.commandPrefix = discordConfig.commandPrefix;
    
    client.registry
        .registerDefaultTypes()
        .registerGroups([
            ['user', 'User Commands']
        ])
        .registerCommandsIn(path.join(__dirname, 'commands'));
    
    client.on('ready', async () => {
        console.log('[Bot] Connected as ' + client.user.tag);
        TwitchMonitor.start();
        const roleChannel = await client.channels.fetch(discordChannels[discordConfig.roleAssignmentChannel]);
        roleChannel.messages.fetch(discordMessages[discordConfig.roleAssignmentMessage])
            .catch(async () => {
                const roleMsg = await roleChannel.send(
                    `React to this message with ${Emojis.checkmark} to be assigned the <@&${discordRoles[discordConfig.roleToPing]}> `
                    + `role and be notified when channels go online.\nTo stop being notified, react instead with ${Emojis.xmark} and `
                    + `the role will be removed.\n(Your reaction will be removed after the role is assigned/removed. If it isn't, please contact an admin.)`
                );
                roleMsg.react(Emojis.checkmark);
                roleMsg.react(Emojis.xmark);
    
                discordMessages[discordConfig.roleAssignmentMessage] = roleMsg.id;
                db.updateRoleAssignmentMessageConfig(roleMsg.id);
            });
    
        if (discordConfig.pingOnStartup) {
            const owner = await client.users.fetch(discordUsers.space)
            owner.send("[Bot] Bot successfully started.");
        }
    });
    
    client.on('guildMemberAdd', member => {
        if (member.id === discordUsers.peru) {
            member.roles.add(dataState.perutags);
            member.setNickname(dataState.peruname);
            console.log(`[Bot] Set role and nickname of Peruman to ${dataState.peruname}`);
        }
    });
    
    client.on('message', async message => {
        const user = await db.getDiscordUser(message.author.id);
        if (user && !user.nitro) {
            const emojis = Object.values(Emojis).reduce((arr, emoji) => {
                const id = emoji.match(/:\d*>/g);
    
                if (id) {
                    arr.push({
                        name: emoji.match(/:.*:/g)[0],
                        id: id[0].slice(1, id[0].length - 1)
                    });
                }
    
                return arr;
            }, []);
    
            const matchedEmojis = emojis.filter(emoji => message.content.includes(emoji.name));
            if (matchedEmojis) {
                matchedEmojis.forEach(emoji => {
                    message.react(emoji.id);
                    console.log(`[Bot] Reacted to a message with emoji ${emoji.id}`);
                });
            }
        }
    });
    
    client.on('messageReactionAdd', (reaction, user) => {
        if (
            reaction.message.id !== discordMessages[discordConfig.roleAssignmentMessage]
            || client.user.id === user.id
        ) { return; }
    
        if (reaction.emoji.name == Emojis.checkmark) {
            reaction.message.guild.members.fetch(user.id).then(member => {
                member.roles.add(discordRoles[discordConfig.roleToPing]);
                console.log(`[Bot] Given ping role to ${user.username}`);
            });
        }
    
        if (reaction.emoji.name == Emojis.xmark) {
            reaction.message.guild.members.fetch(user.id).then(member => {
                member.roles.remove(discordRoles[discordConfig.roleToPing]);
                console.log(`[Bot] Removed ping role from ${user.username}`);
            });
        }
        
        reaction.users.remove(user.id);
    });
    
    /**
     * Twitch integration based on the Timbot from github:
     * https://github.com/roydejong/timbot/tree/fd16e7fe706ea8e9b19e3fbff29aa45f463a0585
     */
    TwitchMonitor.onChannelLiveUpdate(async (streamData, isOnline) => {
        const isChannelCurrentlyLive = await StreamActivity.isChannelOnline(streamData);
    
        if (isOnline && !isChannelCurrentlyLive) {
            StreamActivity.setChannelOnline(streamData);
    
            if (await isReadyForPing(streamData)) {
                const channel = await client.channels.fetch(discordChannels[discordConfig.alertChannel]);
                CustomEmbed.getCustomAlertMessage(customTwitchAlerts, streamData, discordRoles[discordConfig.roleToPing])
                    .then(message => {
                        channel.send(message.content, {
                            embed: message.embed
                        });
                        StreamActivity.setChannelLastPingTimestamp(streamData);
                        console.log(`[Bot] Sent live notification for ${streamData.user_name}`);
                    });
            }
        }
    });
    
    const isReadyForPing = async streamData => {
        const lastPingTimestamp = await StreamActivity.getChannelLastPingTimestamp(streamData);
        const lastOfflineTimestamp = await StreamActivity.getChannelLastOfflineTimestamp(streamData);
    
        const now = new Date().getTime();
        const enoughTimeBetweenPings = !lastPingTimestamp || now -lastPingTimestamp.getTime() > discordConfig.pingInterval;
        const enoughTimeOffline = !lastOfflineTimestamp || now - lastOfflineTimestamp.getTime() > discordConfig.offlineInterval;
    
        return enoughTimeBetweenPings && enoughTimeOffline;
    };
    
    TwitchMonitor.onChannelOffline((streamData) => {
        StreamActivity.setChannelOffline(streamData);
        StreamActivity.setChannelLastOfflineTimestamp(streamData);
    });
    
    client.login(process.env.TOKEN);
});