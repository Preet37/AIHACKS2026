import os
import asyncio
import discord
from discord.ext import commands
import requests
from dotenv import load_dotenv

load_dotenv()

# Configuration
TOKEN = os.getenv("DISCORD_BOT_TOKEN")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")

# CRITICAL: Replace these with your actual copied channel IDs
TARGET_TEXT_CHANNEL_ID = 1518328611713581356  
TARGET_VOICE_CHANNEL_ID = 1518327260019425393

# Load Opus for Mac (fixes the OpusNotLoaded error)
if not discord.opus.is_loaded():
    try:
        # Apple Silicon Mac (M1/M2/M3) path
        discord.opus.load_opus('/opt/homebrew/lib/libopus.dylib')
    except Exception:
        try:
            # Intel Mac path
            discord.opus.load_opus('/usr/local/lib/libopus.dylib')
        except Exception as e:
            print(f"⚠️ Could not load Opus library: {e}")

intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True

bot = commands.Bot(command_prefix="!", intents=intents)

def text_to_speech_deepgram(text, output_filename="alert.mp3"):
    """Hits Deepgram Aura TTS API to generate an audio file."""
    url = "https://api.deepgram.com/v1/speak?model=aura-asteria-en" 
    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "text": text
    }
    
    response = requests.post(url, headers=headers, json=payload, stream=True)
    
    if response.status_code == 200:
        with open(output_filename, "wb") as f:
            for chunk in response.iter_content(chunk_size=1024):
                if chunk:
                    f.write(chunk)
        return True
    else:
        print(f"❌ Deepgram API Error: {response.status_code} - {response.text}")
        return False

@bot.event
async def on_ready():
    print(f"⚡ Conjure Voice Pager online as {bot.user}")

@bot.event
async def on_message(message):
    if message.author == bot.user:
        return

    if message.channel.id == TARGET_TEXT_CHANNEL_ID:
        # Extract content from normal text OR from Sentry webhooks/embeds
        extracted_text = message.content or ""
        
        if message.embeds:
            for embed in message.embeds:
                embed_text = ""
                if embed.title: embed_text += f"{embed.title}. "
                if embed.description: embed_text += f"{embed.description}."
                extracted_text += f" {embed_text}"
        
        extracted_text = extracted_text.strip()
        
        if not extracted_text:
            print("⚠️ Received a message, but no readable text or embed content was found.")
            return

        print(f"📢 Processing alert text: {extracted_text}")
        
        alert_text = f"Alert from Sentry. {extracted_text}"
        success = text_to_speech_deepgram(alert_text, "alert.mp3")
        
        if success:
            voice_channel = bot.get_channel(TARGET_VOICE_CHANNEL_ID)
            if voice_channel:
                vc = discord.utils.get(bot.voice_clients, guild=message.guild)
                
                # If not connected, connect to the channel
                if not vc:
                    try:
                        print(f"🎙️ Connecting to voice channel: {voice_channel.name}...")
                        vc = await voice_channel.connect()
                        print("⏳ Waiting 2 seconds for UDP voice sockets to stabilize...")
                        await asyncio.sleep(2)
                    except Exception as e:
                        print(f"❌ Failed to connect to voice channel: {e}")
                        return
                
                # Play the file if nothing else is playing
                if vc and not vc.is_playing():
                    print("🎵 Pumping audio stream via FFmpeg...")
                    try:
                        vc.play(
                            discord.FFmpegPCMAudio("alert.mp3"), 
                            after=lambda e: print(f"Playback finished. Errors: {e}" if e else "Playback completely successful!")
                        )
                    except Exception as e:
                        print(f"❌ FFmpeg Playback Error: {e}")
            else:
                print("❌ Error: Target voice channel not found.")

    await bot.process_commands(message)

@bot.event
async def on_voice_state_update(member, before, after):
    # Ignore if the bot itself is the one moving
    if member.bot:
        return

    # Check if the user just joined your specific voice channel
    if after.channel and after.channel.id == TARGET_VOICE_CHANNEL_ID and before.channel != after.channel:
        print(f"👋 {member.name} joined! Triggering the Sentry demo alert...")
        
        demo_text = "Processing alert text: Conjure frontend Type Error. Cannot read properties of null, reading style. Please check Sentry Logs as required. Sentry has shared logs to BrowserBase."
        
        # Generate the audio file (saving as demo_alert.mp3 to avoid conflicts)
        success = text_to_speech_deepgram(demo_text, "demo_alert.mp3")
        
        if success:
            voice_channel = bot.get_channel(TARGET_VOICE_CHANNEL_ID)
            vc = discord.utils.get(bot.voice_clients, guild=member.guild)
            
            if not vc:
                try:
                    vc = await voice_channel.connect()
                    await asyncio.sleep(2) 
                except Exception as e:
                    print(f"❌ Failed to connect: {e}")
                    return
            
            if vc and not vc.is_playing():
                print("🎵 Playing demo alert...")
                vc.play(discord.FFmpegPCMAudio("demo_alert.mp3"))

bot.run(TOKEN)