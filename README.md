# TeleDown - Telegram Video Downloader

A powerful web-based Telegram video downloader that supports downloading videos from both public and **private channels** that you have access to.

## ✨ Key Features

- 🔐 **Download from Private Channels** - Access and download videos from private Telegram channels you're a member of
- 📺 Support for public channels and groups
- 🎥 High-quality video downloads with original resolution
- 📊 Progress tracking with real-time updates via WebSocket
- 🌐 Web-based interface - no installation required for users
- 🚀 Fast and efficient downloading with concurrent support
- 📱 Responsive design for desktop and mobile
- 🔄 Session persistence - stay logged in across restarts
- 🔽 **Dual Download Options** - Choose between single video download or intelligent batch download
- 🤖 **Smart Batch Detection** - Automatically finds and groups related videos for batch downloading
- 🔍 **In-Channel Search** - Search for specific content within channels
- ⏫ **Smart Navigation** - Load newer or older messages with dedicated buttons
- 🎯 **Queue Management** - Configurable concurrent download limits for optimal performance
- 🔁 **Auto-Retry** - Automatic retry mechanism for failed downloads with exponential backoff

## 🛠️ Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express + TypeScript
- **Telegram API**: GramJS (MTProto client)
- **Database**: SQLite for session management
- **Real-time Updates**: Socket.IO
- **UI Components**: Ant Design

## 📋 Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Telegram API credentials (API ID and API Hash)

## 🚀 Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/yourusername/teledown.git
cd teledown
```

### Step 2: Install Dependencies

Install backend dependencies:
```bash
cd backend
npm install
```

Install frontend dependencies:
```bash
cd ../frontend
npm install
```

### Step 3: Configure Telegram API

1. **Get your Telegram API credentials**:
   - Visit https://my.telegram.org
   - Log in with your phone number
   - Go to "API Development Tools"
   - Create a new application if you haven't already
   - Copy your `api_id` and `api_hash`

2. **Create environment configuration**:

Backend configuration (`backend/.env`):
```env
API_ID=your_api_id
API_HASH=your_api_hash
SESSION_STRING=optional_session_string
PORT=8000
DATABASE_PATH=./database.db
DOWNLOAD_PATH=./downloads
MAX_CONCURRENT_DOWNLOADS=2  # Number of simultaneous downloads (default: 2)
```

Frontend configuration (`frontend/.env`):
```env
VITE_API_URL=http://localhost:8000
```

### Step 4: Build the Project

Build the backend:
```bash
cd backend
npm run build
```

Build the frontend:
```bash
cd ../frontend
npm run build
```

## 🏃‍♂️ Running the Application

### Development Mode

Start the backend server:
```bash
cd backend
npm run dev
```

In a new terminal, start the frontend development server:
```bash
cd frontend
npm run dev
```

The application will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000

### Production Mode

Start the backend server:
```bash
cd backend
npm start
```

For the frontend, serve the built files:
```bash
cd frontend
npm run preview
# Or use any static server like nginx, apache, etc.
```

## 🌟 Key Features Explained

### Smart Download System

TeleDown features an intelligent dual-download system that adapts to your needs:

#### 🔽 Single Video Download (Blue Button)
- Downloads only the selected video file
- Perfect for specific content you need immediately
- Faster for individual files
- No additional processing or analysis

#### 📦 Intelligent Batch Download (Purple Button)
- **Smart Content Detection**: Automatically analyzes message patterns to find related videos
- **Text Message Association**: Uses adjacent text messages to group related content
- **Automatic Folder Organization**: Creates folders based on the descriptive text content
- **Confirmation Dialog**: Shows you exactly what will be downloaded before starting
- **Queue Management**: Downloads are processed in controlled batches (configurable via MAX_CONCURRENT_DOWNLOADS)
- **Clean File Naming**: Preserves original filenames from Telegram for consistency

**How Batch Download Works:**
1. Analyzes the selected video's context within the channel
2. Searches backward and forward for related text messages
3. Identifies video groups based on message timestamps and content patterns  
4. Presents a confirmation dialog with folder name and video list
5. Downloads all related videos to an organized folder structure

This intelligent system is perfect for content series, multi-part videos, or collections that are posted together but may be separated by other messages in the channel.

## 📖 Usage Guide

### 1. Login to Telegram

- Open the application in your browser
- Enter your phone number with country code
- Enter the verification code sent to your Telegram app
- If you have 2FA enabled, enter your password
- Your session will be saved for future use

### 2. Browse Channels

- View all channels you have access to (both public and private)
- Search channels by name
- See channel statistics (member count, post count)
- Channels are paginated for better performance

### 3. Download Videos

- Click on any channel to view its media content
- Preview video thumbnails and information with metadata (duration, file size)
- **Two Download Options Available**:
  - **🔽 Single Download (Blue Button)**: Downloads only the selected video
  - **📦 Batch Download (Purple Button)**: Automatically finds and downloads all related videos in the group
- Monitor real-time download progress with WebSocket updates
- Downloads are organized into folders based on content groups
- All downloads are saved to the configured directory

### 4. Manage Downloads

- View active downloads with progress bars
- See queued downloads waiting to start
- Cancel unwanted downloads
- Access download history
- Automatic retry for failed downloads (FILE_REFERENCE_EXPIRED errors)
- Configurable concurrent download limits

## 🔒 Security & Privacy

- **Secure Authentication**: Uses official Telegram MTProto protocol
- **Session Encryption**: All session data is encrypted locally
- **No Third Parties**: Direct connection to Telegram servers
- **Private Downloads**: Your download activity is completely private
- **Data Protection**: No user data is collected or shared

## 📁 Project Structure

```
teledown/
├── backend/
│   ├── src/
│   │   ├── controllers/     # Request handlers
│   │   ├── services/        # Business logic
│   │   ├── models/          # Data models
│   │   ├── routes/          # API routes
│   │   ├── utils/           # Utility functions
│   │   └── index.ts         # Entry point
│   ├── downloads/           # Downloaded files
│   ├── sessions/            # User sessions
│   └── database.db          # SQLite database
├── frontend/
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── pages/           # Page components
│   │   ├── services/        # API services
│   │   ├── hooks/           # Custom hooks
│   │   ├── utils/           # Utilities
│   │   └── App.tsx          # Main component
│   └── dist/                # Built files
└── README.md
```

## 🔧 API Documentation

### Authentication
- `POST /api/auth/send-code` - Send verification code
- `POST /api/auth/verify-code` - Verify code and login
- `POST /api/auth/check-session` - Check session status
- `POST /api/auth/logout` - Logout and clear session

### Channels
- `GET /api/channels` - List all accessible channels
- `GET /api/channels/:id` - Get channel details
- `GET /api/channels/:id/media` - Get channel media

### Downloads
- `POST /api/download/start` - Start single video download
- `POST /api/download/batch` - Start batch download of related videos
- `POST /api/download/find-related` - Find videos related to a specific video
- `GET /api/download/progress/:id` - Get download progress
- `POST /api/download/cancel/:id` - Cancel download
- `GET /api/download/history` - Get download history

## 🚨 Troubleshooting

### Common Issues

1. **Login Issues**
   - Ensure phone number includes country code
   - Check if 2FA is enabled on your account
   - Clear browser cache and cookies

2. **Download Failures**
   - Check internet connection
   - Verify you have access to the channel
   - Ensure sufficient disk space
   - FILE_REFERENCE_EXPIRED errors are automatically retried

3. **Session Expired**
   - Re-login with your credentials
   - Sessions expire after 30 days of inactivity

4. **Slow Batch Downloads**
   - Adjust MAX_CONCURRENT_DOWNLOADS in .env file
   - Default is 2 for stability, can be increased based on your connection

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Write unit tests for new features
- Update documentation as needed
- Ensure code passes linting

## ⚠️ Disclaimer

This tool is intended for personal use only. Please respect content creators' rights and Telegram's Terms of Service:

- Only download content you have permission to access
- Do not redistribute downloaded content without permission
- Respect copyright and intellectual property rights
- Use responsibly and ethically

The developers are not responsible for any misuse of this tool.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [GramJS](https://github.com/gram-js/gramjs) - Telegram MTProto client library
- [Ant Design](https://ant.design/) - React UI component library
- [Vite](https://vitejs.dev/) - Next generation frontend tooling
- [Socket.IO](https://socket.io/) - Real-time bidirectional communication

## 📞 Support

If you encounter any issues or have questions:

- Check the [Issues](https://github.com/yourusername/teledown/issues) page
- Create a new issue with detailed information
- Include error messages and steps to reproduce
- Join our [Telegram Support Group](https://t.me/teledown_support)

## 🔮 Future Features

- [x] Batch download with queue management
- [x] In-channel search functionality
- [x] Load newer/older messages navigation
- [ ] Download scheduling
- [ ] Video quality selection
- [ ] Audio-only extraction
- [ ] Subtitle download support
- [ ] Docker support for easy deployment
- [ ] Mobile app (React Native)
- [ ] Download resume capability
- [ ] Export download history

---

**⭐ Star this repository if you find it useful!**

**Note**: This tool requires active Telegram account authentication and only works with channels you have legitimate access to. It's designed to help you manage and backup your accessible content for personal use.