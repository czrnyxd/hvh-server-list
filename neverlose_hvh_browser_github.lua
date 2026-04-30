local endpoint = "https://czrnyxd.github.io/hvh-server-list/servers.json"

local group = ui.create("HvH Browser")

local search = group:input("Search", "")
local list = group:list("Servers", { "Press Refresh" })
local status = group:label("Status: idle")

local servers = {}
local visible = {}
local visible_items = {}

local function set_status(text)
    status:name("Status: " .. text)
end

local function safe_text(value)
    if value == nil then
        return ""
    end

    return tostring(value)
end

local function format_server(server)
    if not server.online then
        return string.format("%s | offline", safe_text(server.address))
    end

    return string.format(
        "%s | %s | %s | %s/%s | %sms",
        safe_text(server.address),
        safe_text(server.map),
        safe_text(server.name),
        safe_text(server.players),
        safe_text(server.max_players),
        safe_text(server.ping_ms)
    )
end

local function address_is_safe(address)
    return type(address) == "string" and address:match("^%d+%.%d+%.%d+%.%d+:%d+$") ~= nil
end

local function rebuild_list()
    local query = string.lower(search:get() or "")
    local items = {}

    visible = {}
    visible_items = {}

    for _, server in ipairs(servers) do
        local haystack = string.lower(
            safe_text(server.address) .. " " ..
            safe_text(server.name) .. " " ..
            safe_text(server.map) .. " " ..
            safe_text(server.keywords)
        )

        if query == "" or string.find(haystack, query, 1, true) then
            local item = format_server(server)
            table.insert(visible, server)
            table.insert(visible_items, item)
            table.insert(items, item)
        end
    end

    if #items == 0 then
        items = { "No servers found" }
    end

    list:update(items)
    set_status(tostring(#visible) .. " visible / " .. tostring(#servers) .. " total")
end

local function parse_servers(body)
    local ok, parsed = pcall(json.parse, body or "")

    if not ok or type(parsed) ~= "table" then
        set_status("bad JSON from GitHub Pages")
        return
    end

    servers = parsed
    rebuild_list()
end

local function refresh()
    set_status("loading")

    local done = false
    local function finish(body)
        if done then
            return
        end

        done = true
        parse_servers(body)
    end

    local returned = network.get(endpoint .. "?t=" .. tostring(common.get_unixtime()), {}, function(body)
        finish(body)
    end)

    if type(returned) == "string" and returned ~= "" then
        finish(returned)
    end
end

group:button("Refresh", refresh)

group:button("Connect selected", function()
    local raw = list:get()
    local selected = tonumber(raw)
    local server = nil

    if selected ~= nil then
        server = visible[selected] or visible[selected + 1]
    elseif type(raw) == "string" then
        for index, item in ipairs(visible_items) do
            if item == raw then
                server = visible[index]
                break
            end
        end
    end

    server = server or visible[1]

    if not server or not address_is_safe(server.address) then
        set_status("no valid selected server")
        return
    end

    utils.console_exec("connect " .. server.address)
    set_status("connecting to " .. server.address)
end)

search:set_callback(rebuild_list)

refresh()
