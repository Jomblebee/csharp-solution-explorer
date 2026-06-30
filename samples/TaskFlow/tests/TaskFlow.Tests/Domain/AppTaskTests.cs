using TaskFlow.Domain.Entities;
using TaskFlow.Domain.Enums;
using Xunit;

namespace TaskFlow.Tests.Domain;

public class AppTaskTests
{
    [Fact]
    public void NewAppTask_HasDefaultStatusTodo()
    {
        var task = new AppTask { Title = "Test task" };
        Assert.Equal(AppTaskStatus.Todo, task.Status);
    }

    [Fact]
    public void NewAppTask_HasDefaultPriorityMedium()
    {
        var task = new AppTask { Title = "Test task" };
        Assert.Equal(Priority.Medium, task.Priority);
    }

    [Fact]
    public void NewAppTask_HasEmptyTagCollection()
    {
        var task = new AppTask { Title = "Test task" };
        Assert.Empty(task.Tags);
    }
}
