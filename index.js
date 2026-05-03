const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const dotenv = require('dotenv');
const authRoutes = require('./routes/auth');
const { Server } = require('socket.io');
const Messages = require('./models/Messages');
const User = require('./models/User');

dotenv.config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  'http://localhost:3000',
  'https://chat-app-frontend-ten-nu.vercel.app'
];

console.log('Allowed origins:', allowedOrigins);

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

/* ---------------- DB ---------------- */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Mongoose connected.'))
  .catch(err => console.error('MongoDB connection error:', err));

/* ---------------- Routes ---------------- */
app.use('/auth', authRoutes);

/* ---------------- Socket Logic ---------------- */
const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  /* ---- USER JOIN ---- */
  socket.on('join', async (username) => {
    try {
      if (!username) return;

      onlineUsers[username] = socket.id;
      socket.join(username);

      const pendingMessages = await Messages.find({
        receiver: username,
        status: 'sent'
      });

      for (const msg of pendingMessages) {
        msg.status = 'delivered';
        await msg.save();

        if (onlineUsers[msg.sender]) {
          io.to(msg.sender).emit('message_delivered', {
            messageId: msg._id
          });
        }
      }
    } catch (err) {
      console.error('Join error:', err);
    }
  });

  /* ---- SEND MESSAGE ---- */
  socket.on('send_message', async (data) => {
    try {
      const { sender, receiver, message } = data;

      if (!sender || !receiver || !message) return;

      const newMessage = new Messages({
        sender,
        receiver,
        message,
        status: 'sent',
        createdAt: new Date()
      });

      await newMessage.save();

      io.to(sender).emit('receive_message', newMessage);
      io.to(receiver).emit('receive_message', newMessage);

      if (onlineUsers[receiver]) {
        newMessage.status = 'delivered';
        await newMessage.save();

        io.to(sender).emit('message_delivered', {
          messageId: newMessage._id
        });
      }
    } catch (err) {
      console.error('Send message error:', err);
    }
  });

  /* ---- TYPING ---- */
  socket.on('typing', ({ sender, receiver }) => {
    if (receiver && onlineUsers[receiver]) {
      io.to(receiver).emit('typing', { sender });
    }
  });

  socket.on('stop_typing', ({ sender, receiver }) => {
    if (receiver && onlineUsers[receiver]) {
      io.to(receiver).emit('stop_typing', { sender });
    }
  });

  /* ---- READ RECEIPT ---- */
  socket.on('mark_seen', async ({ messageId, sender }) => {
    try {
      if (!messageId || !sender) return;

      await Messages.findByIdAndUpdate(messageId, { status: 'seen' });

      if (onlineUsers[sender]) {
        io.to(sender).emit('message_seen', { messageId });
      }
    } catch (err) {
      console.error('Mark seen error:', err);
    }
  });

  /* ---- DISCONNECT ---- */
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    for (const user in onlineUsers) {
      if (onlineUsers[user] === socket.id) {
        delete onlineUsers[user];
        break;
      }
    }
  });
});

/* ---------------- REST APIs ---------------- */
app.get('/messages', async (req, res) => {
  const { sender, receiver } = req.query;

  try {
    const messages = await Messages.find({
      $or: [
        { sender, receiver },
        { sender: receiver, receiver: sender }
      ]
    }).sort({ createdAt: 1 });

    res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ message: 'Error fetching messages' });
  }
});

app.get('/users', async (req, res) => {
  const { currentUser } = req.query;

  try {
    const users = await User.find({
      username: { $ne: currentUser }
    });

    res.json(users);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ message: 'Error fetching users' });
  }
});

app.delete('/users/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ message: 'Error deleting user' });
  }
});

/* ---- UNREAD COUNT ---- */
app.get('/unread-count', async (req, res) => {
  const { currentUser } = req.query;

  try {
    const counts = await Messages.aggregate([
      { $match: { receiver: currentUser, status: { $ne: 'seen' } } },
      { $group: { _id: '$sender', count: { $sum: 1 } } }
    ]);

    const result = {};
    counts.forEach(c => {
      result[c._id] = c.count;
    });

    res.json(result);
  } catch (err) {
    console.error('Error fetching unread counts:', err);
    res.status(500).json({ message: 'Error fetching unread counts' });
  }
});

/* ---- CHAT DATES ---- */
app.get('/chat-dates', async (req, res) => {
  const { currentUser } = req.query;

  try {
    const chats = await Messages.aggregate([
      {
        $match: {
          $or: [
            { sender: currentUser },
            { receiver: currentUser }
          ]
        }
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$sender', currentUser] },
              '$receiver',
              '$sender'
            ]
          },
          lastDate: { $first: '$createdAt' }
        }
      }
    ]);

    const result = {};
    chats.forEach(c => {
      result[c._id] = c.lastDate;
    });

    res.json(result);
  } catch (err) {
    console.error('Error fetching chat dates:', err);
    res.status(500).json({ message: 'Error fetching chat dates' });
  }
});

/* ---------------- Server ---------------- */
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on PORT ${PORT}`);
});