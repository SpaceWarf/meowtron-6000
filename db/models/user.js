const mongoose = require('mongoose');

var userSchema = new mongoose.Schema({
    username: String,
    id: String,
    nitro: Boolean,
    attributes: {
        str: Number,
        dex: Number,
        con: Number,
        int: Number,
        wis: Number,
        cha: Number
    },
    race: String,
    class: String
});

module.exports = mongoose.model('users', userSchema);