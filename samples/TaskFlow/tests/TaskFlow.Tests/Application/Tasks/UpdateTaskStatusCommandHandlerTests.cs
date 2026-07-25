using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Tasks.Commands.UpdateTaskStatus;
using TaskFlow.Domain.Entities;
using TaskFlow.Domain.Enums;
using TaskFlow.Domain.Exceptions;
using TaskFlow.Infrastructure.Persistence;
using Xunit;

namespace TaskFlow.Tests.Application.Tasks;

public class UpdateTaskStatusCommandHandlerTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    private static async Task<int> SeedTaskAsync(TaskFlowDbContext context)
    {
        var task = new AppTask { Title = "Seed task", Status = AppTaskStatus.Todo };
        context.Tasks.Add(task);
        await context.SaveChangesAsync();
        return task.Id;
    }

    [Fact]
    public async Task Handle_ExistingTask_UpdatesStatus()
    {
        await using var context = CreateContext(nameof(Handle_ExistingTask_UpdatesStatus));
        var id = await SeedTaskAsync(context);
        var handler = new UpdateTaskStatusCommandHandler(context);

        await handler.Handle(new UpdateTaskStatusCommand(id, AppTaskStatus.Done), default);

        var task = await context.Tasks.FindAsync(id);
        Assert.NotNull(task);
        Assert.Equal(AppTaskStatus.Done, task.Status);
    }

    [Fact]
    public async Task Handle_MissingTask_ThrowsDomainException()
    {
        await using var context = CreateContext(nameof(Handle_MissingTask_ThrowsDomainException));
        var handler = new UpdateTaskStatusCommandHandler(context);

        await Assert.ThrowsAsync<DomainException>(() =>
            handler.Handle(new UpdateTaskStatusCommand(999, AppTaskStatus.Done), default));
    }

    // Data-driven: shows up grouped under one method in the Test Explorer.
    [Theory]
    [InlineData(AppTaskStatus.Todo)]
    [InlineData(AppTaskStatus.InProgress)]
    [InlineData(AppTaskStatus.Done)]
    public async Task Handle_VariousStatuses_SetsStatus(AppTaskStatus target)
    {
        await using var context = CreateContext($"{nameof(Handle_VariousStatuses_SetsStatus)}_{target}");
        var id = await SeedTaskAsync(context);
        var handler = new UpdateTaskStatusCommandHandler(context);

        await handler.Handle(new UpdateTaskStatusCommand(id, target), default);

        var task = await context.Tasks.FindAsync(id);
        Assert.NotNull(task);
        Assert.Equal(target, task.Status);
    }
}
