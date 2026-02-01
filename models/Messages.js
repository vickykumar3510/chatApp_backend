const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    sender: { type: String, required: true },
    receiver: { type: String, required: true },
    message: { type: String, required: true },

    status: {
        type: String,
        enum: ["sent", "delivered", "seen"],
        default: "sent"
    }
},
{
    timestamps: true
});

module.exports = mongoose.model('Messages', messageSchema);
