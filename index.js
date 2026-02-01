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

const io = new Server(server, {
    cors: { origin: 'http://localhost:3000' }
});

app.use(cors());
app.use(express.json());

/* ---------------- DB ---------------- */
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('Mongoose connected.'))
.catch(err => console.error(err));

/* ---------------- Routes ---------------- */
app.use('/auth', authRoutes);

/* ---------------- Socket Logic ---------------- */

// Track online users: username -> socket.id
const onlineUsers = {};

io.on('connection', (socket) => {
    console.log("User connected:", socket.id);

    /* ---- USER JOIN ---- */
    socket.on("join", (username) => {
        onlineUsers[username] = socket.id;
        socket.join(username);
        
        // Sync pending messages when user comes online
        Messages.find({ receiver: username, status: "sent" })
            .then(pendingMessages => {
                pendingMessages.forEach(async (msg) => {
                    msg.status = "delivered";
                    await msg.save();
                    
                    // Notify sender
                    if (onlineUsers[msg.sender]) {
                        io.to(msg.sender).emit("message_delivered", { messageId: msg._id });
                    }
                });
            });
    });

    // send message
    socket.on("send_message", async (data) => {
        const { sender, receiver, message } = data;

        const newMessage = new Messages({
            sender,
            receiver,
            message,
            status: "sent",
            createdAt: new Date()
        });

        await newMessage.save();

        // Send to BOTH sender AND receiver
        io.to(sender).emit("receive_message", newMessage);
        io.to(receiver).emit("receive_message", newMessage);

        // Update to delivered if receiver online (gray double tick)
        if (onlineUsers[receiver]) {
            newMessage.status = "delivered";
            await newMessage.save();

            io.to(sender).emit("message_delivered", {
                messageId: newMessage._id
            });
        }
    });

    /* ---- TYPING ---- */
    socket.on("typing", ({ sender, receiver }) => {
        if (onlineUsers[receiver]) {
            io.to(receiver).emit("typing", { sender });
        }
    });

    socket.on("stop_typing", ({ sender, receiver }) => {
        if (onlineUsers[receiver]) {
            io.to(receiver).emit("stop_typing", { sender });
        }
    });

    /* ---- READ RECEIPT ---- */
    socket.on("mark_seen", async ({ messageId, sender }) => {
        await Messages.findByIdAndUpdate(messageId, { status: "seen" });
        if (onlineUsers[sender]) {
            io.to(sender).emit("message_seen", { messageId });
        }
    });

    /* ---- DISCONNECT ---- */
    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
        for (let user in onlineUsers) {
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
    } catch {
        res.status(500).json({ message: "Error fetching messages" });
    }
});

app.get('/users', async (req, res) => {
    const { currentUser } = req.query;

    try {
        const users = await User.find({
            username: { $ne: currentUser }
        });

        res.json(users);
    } catch {
        res.status(500).json({ message: "Error fetching users" });
    }
});


// GET unread messages count per sender for current user
app.get('/unread-count', async (req, res) => {
  const { currentUser } = req.query;

  try {
    const counts = await Messages.aggregate([
      { $match: { receiver: currentUser, status: { $ne: "seen" } } },
      { $group: { _id: "$sender", count: { $sum: 1 } } }
    ]);

    const result = {};
    counts.forEach(c => {
      result[c._id] = c.count;
    });

    res.json(result); // { "user1": 3, "user2": 0 }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching unread counts" });
  }
});

// Get last chat date per user
app.get("/chat-dates", async (req, res) => {
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
              { $eq: ["$sender", currentUser] },
              "$receiver",
              "$sender"
            ]
          },
          lastDate: { $first: "$createdAt" }
        }
      }
    ]);

    const result = {};
    chats.forEach(c => {
      result[c._id] = c.lastDate;
    });

    res.json(result); // { "john": "2024-02-01T10:30:00Z" }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching chat dates" });
  }
});



/* ---------------- Server ---------------- */
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
    console.log(`Server running on PORT ${PORT}`);
});
